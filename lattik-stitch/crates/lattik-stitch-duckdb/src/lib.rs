//! DuckDB loadable extension for Lattik Tables.
//!
//! Registers a `lattik_scan` table function that performs stitch-on-read
//! from S3/MinIO, using the same stitching engine as the Spark and Trino
//! connectors.
//!
//! ## Usage
//!
//! ```sql
//! LOAD 'lattik_stitch_duckdb';
//!
//! SELECT * FROM lattik_scan('user_stats');
//! ```

mod resolve;
mod session;

use std::error::Error;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use duckdb::core::{DataChunkHandle, Inserter, LogicalTypeHandle, LogicalTypeId};
use duckdb::vtab::{BindInfo, InitInfo, TableFunctionInfo, VTab};
use duckdb::{Connection, duckdb_entrypoint_c_api};

use arrow::array::{
    Array, BooleanArray, Float32Array, Float64Array, Int32Array, Int64Array, StringArray,
};
use arrow::datatypes::DataType;

use lattik_stitch_core::types::S3Config;

use resolve::TableScanConfig;
use session::StitchSession;

// ---------------------------------------------------------------------------
// Bind data — carries both schema info and the session for func()
// ---------------------------------------------------------------------------

struct LattikBindData {
    num_columns: usize,
    /// The stitch session. Created in bind(), consumed in func().
    /// Wrapped in Mutex<Option<>> so we can take ownership on first func() call.
    session: Mutex<Option<StitchSession>>,
}

// ---------------------------------------------------------------------------
// Init data — lightweight, just tracks scan completion
// ---------------------------------------------------------------------------

struct LattikInitData {
    /// Holds the session once taken from bind_data on first func() call.
    session: Mutex<Option<StitchSession>>,
    done: AtomicBool,
}

// ---------------------------------------------------------------------------
// VTab implementation
// ---------------------------------------------------------------------------

struct LattikScanVTab;

impl VTab for LattikScanVTab {
    type InitData = LattikInitData;
    type BindData = LattikBindData;

    fn bind(bind: &BindInfo) -> Result<Self::BindData, Box<dyn Error>> {
        let table_name = bind.get_parameter(0).to_string();

        let s3_config = S3Config {
            endpoint: "http://localhost:9000".to_string(),
            region: "us-east-1".to_string(),
            bucket: "lattik-data".to_string(),
            access_key_id: "minioadmin".to_string(),
            secret_access_key: "minioadmin".to_string(),
        };
        let warehouse_path = "s3://lattik-data/warehouse/lattik".to_string();

        let scan_config = TableScanConfig {
            table_name,
            version: 0,
            warehouse_path,
            s3_config,
        };

        let rt = tokio::runtime::Runtime::new()?;
        let session_config = rt
            .block_on(resolve::resolve_table_scan(&scan_config))
            .map_err(|e| Box::new(e) as Box<dyn Error>)?;

        let session = StitchSession::from_config(session_config)
            .map_err(|e| Box::new(e) as Box<dyn Error>)?;

        let schema = session.output_schema().clone();

        for field in schema.fields() {
            let logical_type = arrow_to_duckdb_type(field.data_type());
            bind.add_result_column(field.name(), logical_type);
        }

        let num_columns = schema.fields().len();

        Ok(LattikBindData {
            num_columns,
            session: Mutex::new(Some(session)),
        })
    }

    fn init(_init: &InitInfo) -> Result<Self::InitData, Box<dyn Error>> {
        // Session will be moved from bind_data on first func() call.
        Ok(LattikInitData {
            session: Mutex::new(None),
            done: AtomicBool::new(false),
        })
    }

    fn func(
        func: &TableFunctionInfo<Self>,
        output: &mut DataChunkHandle,
    ) -> Result<(), Box<dyn Error>> {
        let bind_data = func.get_bind_data();
        let init_data = func.get_init_data();

        if init_data.done.load(Ordering::Relaxed) {
            output.set_len(0);
            return Ok(());
        }

        // On first call, take the session from bind_data
        {
            let mut init_session = init_data.session.lock().map_err(|e| e.to_string())?;
            if init_session.is_none() {
                let mut bind_session = bind_data.session.lock().map_err(|e| e.to_string())?;
                *init_session = bind_session.take();
                if init_session.is_none() {
                    return Err("lattik_scan: session already consumed".into());
                }
            }
        }

        let mut init_session = init_data.session.lock().map_err(|e| e.to_string())?;
        let session = init_session
            .as_mut()
            .ok_or("lattik_scan: no session available")?;

        if !session.has_next() {
            init_data.done.store(true, Ordering::Relaxed);
            output.set_len(0);
            return Ok(());
        }

        let batch = session
            .next_batch()
            .map_err(|e| Box::new(e) as Box<dyn Error>)?;

        let row_count = batch.num_rows();
        output.set_len(row_count);

        for (col_idx, column) in batch.columns().iter().enumerate() {
            if col_idx >= bind_data.num_columns {
                break;
            }

            let mut vector = output.flat_vector(col_idx);

            match column.data_type() {
                DataType::Int64 => {
                    let arr = column.as_any().downcast_ref::<Int64Array>().unwrap();
                    copy_primitive(arr.values(), column, &mut vector, row_count);
                }
                DataType::Int32 => {
                    let arr = column.as_any().downcast_ref::<Int32Array>().unwrap();
                    copy_primitive(arr.values(), column, &mut vector, row_count);
                }
                DataType::Float64 => {
                    let arr = column.as_any().downcast_ref::<Float64Array>().unwrap();
                    copy_primitive(arr.values(), column, &mut vector, row_count);
                }
                DataType::Float32 => {
                    let arr = column.as_any().downcast_ref::<Float32Array>().unwrap();
                    copy_primitive(arr.values(), column, &mut vector, row_count);
                }
                DataType::Boolean => {
                    let arr = column.as_any().downcast_ref::<BooleanArray>().unwrap();
                    // DuckDB booleans are stored as u8 (0 or 1)
                    let ptr = vector.as_mut_ptr::<bool>();
                    for row in 0..row_count {
                        unsafe { *ptr.add(row) = arr.value(row) };
                    }
                    set_nulls(column, &mut vector, row_count);
                }
                DataType::Utf8 => {
                    let arr = column.as_any().downcast_ref::<StringArray>().unwrap();
                    for row in 0..row_count {
                        if arr.is_null(row) {
                            vector.set_null(row);
                        } else {
                            vector.insert(row, arr.value(row));
                        }
                    }
                }
                _ => {
                    for row in 0..row_count {
                        vector.set_null(row);
                    }
                }
            }
        }

        Ok(())
    }

    fn parameters() -> Option<Vec<LogicalTypeHandle>> {
        Some(vec![LogicalTypeHandle::from(LogicalTypeId::Varchar)])
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Copy a primitive Arrow buffer into a DuckDB FlatVector, then mark nulls.
/// Splits the mutable borrows to avoid the borrow checker conflict.
fn copy_primitive<T: Copy>(
    values: &[T],
    column: &dyn Array,
    vector: &mut duckdb::core::FlatVector<'_>,
    row_count: usize,
) {
    // First pass: copy all values (including garbage at null positions)
    let ptr = vector.as_mut_ptr::<T>();
    let len = row_count.min(values.len());
    unsafe {
        std::ptr::copy_nonoverlapping(values.as_ptr(), ptr, len);
    }
    // Second pass: mark null rows
    set_nulls(column, vector, row_count);
}

/// Mark null rows in a DuckDB vector based on an Arrow array's null bitmap.
fn set_nulls(
    column: &dyn Array,
    vector: &mut duckdb::core::FlatVector<'_>,
    row_count: usize,
) {
    if column.null_count() > 0 {
        for row in 0..row_count {
            if column.is_null(row) {
                vector.set_null(row);
            }
        }
    }
}

fn arrow_to_duckdb_type(dt: &DataType) -> LogicalTypeHandle {
    match dt {
        DataType::Int32 => LogicalTypeHandle::from(LogicalTypeId::Integer),
        DataType::Int64 => LogicalTypeHandle::from(LogicalTypeId::Bigint),
        DataType::Float32 => LogicalTypeHandle::from(LogicalTypeId::Float),
        DataType::Float64 => LogicalTypeHandle::from(LogicalTypeId::Double),
        DataType::Boolean => LogicalTypeHandle::from(LogicalTypeId::Boolean),
        DataType::Utf8 => LogicalTypeHandle::from(LogicalTypeId::Varchar),
        DataType::Binary => LogicalTypeHandle::from(LogicalTypeId::Blob),
        DataType::Date32 => LogicalTypeHandle::from(LogicalTypeId::Date),
        DataType::Timestamp(_, _) => LogicalTypeHandle::from(LogicalTypeId::Timestamp),
        _ => LogicalTypeHandle::from(LogicalTypeId::Varchar),
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

#[duckdb_entrypoint_c_api()]
pub unsafe fn extension_entrypoint(con: Connection) -> Result<(), Box<dyn Error>> {
    con.register_table_function::<LattikScanVTab>("lattik_scan")?;
    Ok(())
}
