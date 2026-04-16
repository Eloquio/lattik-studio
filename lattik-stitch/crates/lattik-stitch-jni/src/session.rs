use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::ffi::{FFI_ArrowArray, FFI_ArrowSchema};
use arrow::record_batch::RecordBatch;
use jni::sys::jlong;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::{FamilyBucketReader, FamilyFormat};
use lattik_stitch_core::stitcher::indexed::IndexedStitcher;
use lattik_stitch_core::stitcher::naive::NaiveStitcher;
use lattik_stitch_core::stitcher::Stitcher;
use lattik_stitch_core::types::{PkFilter, PkValue, S3Config};

use lattik_format_parquet::ParquetFormat;
use lattik_format_vortex::VortexFormat;

/// Configuration for a stitch session, deserialized from JSON.
#[derive(serde::Deserialize)]
pub struct SessionConfig {
    pub load_specs: Vec<LoadSpec>,
    pub pk_columns: Vec<String>,
    pub stitcher_id: String,
    pub output_columns: Option<Vec<OutputColumn>>,
    pub pk_filter: Option<PkFilterSpec>,
    pub s3_config: S3Config,
}

/// PK filter specification from the query engine.
#[derive(serde::Deserialize)]
pub struct PkFilterSpec {
    /// Filter type: "eq", "in", "range"
    pub filter_type: String,
    /// For "eq": single value. For "in": array of values.
    pub values: Option<Vec<serde_json::Value>>,
    /// For "range": min value
    pub min: Option<serde_json::Value>,
    /// For "range": max value
    pub max: Option<serde_json::Value>,
}

impl PkFilterSpec {
    fn to_pk_filter(&self) -> Result<PkFilter> {
        match self.filter_type.as_str() {
            "eq" => {
                let val = self.values.as_ref()
                    .and_then(|v| v.first())
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("eq filter requires a value")))?;
                Ok(PkFilter::Eq(json_to_pk_value(val)?))
            }
            "in" => {
                let vals = self.values.as_ref()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("in filter requires values")))?;
                let pk_vals: Result<Vec<PkValue>> = vals.iter().map(json_to_pk_value).collect();
                Ok(PkFilter::In(pk_vals?))
            }
            "range" => {
                let min = self
                    .min
                    .as_ref()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("range filter requires min")))?;
                let max = self
                    .max
                    .as_ref()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("range filter requires max")))?;
                Ok(PkFilter::Range {
                    min: json_to_pk_value(min)?,
                    max: json_to_pk_value(max)?,
                })
            }
            other => Err(StitchError::Other(anyhow::anyhow!("Unsupported filter type: {other}"))),
        }
    }
}

fn json_to_pk_value(v: &serde_json::Value) -> Result<PkValue> {
    if let Some(n) = v.as_i64() {
        Ok(PkValue::Int64(n))
    } else if let Some(s) = v.as_str() {
        Ok(PkValue::Utf8(s.to_string()))
    } else {
        Err(StitchError::Other(anyhow::anyhow!("Unsupported PK value type: {v}")))
    }
}

#[derive(serde::Deserialize)]
pub struct LoadSpec {
    pub load_id: String,
    pub path: String,
    pub columns: Vec<String>,
    pub pk_columns: Vec<String>,
    pub format_id: String,
    pub sorted: bool,
    pub has_pk_index: bool,
}

#[derive(serde::Deserialize)]
pub struct OutputColumn {
    pub name: String,
    pub data_type: String,
}

/// A stitch session wraps a Stitcher and produces RecordBatches.
pub struct StitchSession {
    stitcher: Box<dyn Stitcher>,
    output_schema: Schema,
}

impl StitchSession {
    /// Create a session from a JSON config string.
    pub fn from_json(config_json: &str) -> Result<Self> {
        eprintln!("[lattik-stitch] Creating session from JSON config ({} bytes)", config_json.len());
        let config: SessionConfig =
            serde_json::from_str(config_json).map_err(|e| {
                eprintln!("[lattik-stitch] JSON parse error: {e}");
                StitchError::Other(e.into())
            })?;
        eprintln!("[lattik-stitch] Config parsed: {} load_specs, pk_columns={:?}", config.load_specs.len(), config.pk_columns);
        if config.load_specs.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "Session config must include at least one load"
            )));
        }

        // Build the output schema from the config.
        // Types come from output_columns (derived from the table spec by the Kotlin side).
        // No Parquet file reading needed for schema inference.
        let output_schema = build_output_schema(&config);
        eprintln!(
            "[lattik-stitch] Output schema (from spec): {:?}",
            output_schema.fields().iter().map(|f| format!("{}:{}", f.name(), f.data_type())).collect::<Vec<_>>()
        );

        // Open bucket readers for each load
        let mut readers: HashMap<String, Box<dyn FamilyBucketReader>> = HashMap::new();
        for spec in &config.load_specs {
            let format: Box<dyn FamilyFormat> = match spec.format_id.as_str() {
                "parquet" => Box::new(ParquetFormat),
                "vortex" => Box::new(VortexFormat),
                other => {
                    return Err(StitchError::UnsupportedOperation {
                        format: other.to_string(),
                        operation: "open_bucket".to_string(),
                    })
                }
            };

            let load_schema = build_load_schema(spec, &output_schema);
            let reader = format.open_bucket(
                &spec.path,
                &load_schema,
                &spec.pk_columns,
                &config.s3_config,
            )?;

            eprintln!("[lattik-stitch] Opened reader for load '{}' at path '{}'", spec.load_id, spec.path);
            readers.insert(spec.load_id.clone(), reader);
        }

        // Parse PK filter if provided
        let pk_filter = config
            .pk_filter
            .as_ref()
            .map(|spec| spec.to_pk_filter())
            .transpose()?;

        eprintln!(
            "[lattik-stitch] Creating stitcher '{}' (pk_filter: {})",
            config.stitcher_id,
            if pk_filter.is_some() { "yes" } else { "no" }
        );

        // Create the stitcher
        let mut stitcher: Box<dyn Stitcher> = match config.stitcher_id.as_str() {
            "naive" => Box::new(NaiveStitcher::new()),
            "indexed" => Box::new(IndexedStitcher::new()),
            other => {
                return Err(StitchError::Other(
                    anyhow::anyhow!("Unknown stitcher: {other}"),
                ))
            }
        };

        stitcher.init(
            readers,
            config.pk_columns,
            output_schema.clone(),
            pk_filter,
        )?;

        Ok(Self {
            stitcher,
            output_schema,
        })
    }

    pub fn has_next(&self) -> bool {
        self.stitcher.has_next()
    }

    /// Export the next RecordBatch via Arrow C Data Interface.
    ///
    /// Writes to the FFI_ArrowSchema and FFI_ArrowArray at the given pointers.
    /// Returns true if a batch was produced, false if exhausted.
    pub fn next_batch_to_ffi(
        &mut self,
        schema_ptr: jlong,
        array_ptr: jlong,
    ) -> Result<bool> {
        if !self.stitcher.has_next() {
            return Ok(false);
        }

        let batch = self.stitcher.next_batch()?;

        // Export via Arrow C Data Interface
        let struct_array = arrow::array::StructArray::from(batch);
        let data = struct_array.into_data();

        unsafe {
            let ffi_schema = schema_ptr as *mut FFI_ArrowSchema;
            let ffi_array = array_ptr as *mut FFI_ArrowArray;

            let exported = arrow::ffi::to_ffi(&data)
                .map_err(StitchError::Arrow)?;

            std::ptr::write(ffi_array, exported.0);
            std::ptr::write(ffi_schema, exported.1);
        }

        Ok(true)
    }

    /// Export just the output schema via Arrow C Data Interface.
    pub fn export_schema(&self, schema_ptr: jlong) -> Result<()> {
        unsafe {
            let ffi_schema = schema_ptr as *mut FFI_ArrowSchema;
            let exported = FFI_ArrowSchema::try_from(&self.output_schema)
                .map_err(|e| StitchError::Arrow(e))?;
            std::ptr::write(ffi_schema, exported);
        }
        Ok(())
    }
}

/// Build the output schema from load specs.
/// PK columns come first, then payload columns from all loads.
fn build_output_schema(config: &SessionConfig) -> Schema {
    let mut fields: Vec<Field> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let explicit_types: std::collections::HashMap<String, DataType> = config
        .output_columns
        .as_ref()
        .map(|columns| {
            columns
                .iter()
                .map(|column| (column.name.clone(), parse_data_type(&column.data_type)))
                .collect()
        })
        .unwrap_or_default();

    // PK columns first
    for pk in &config.pk_columns {
        if seen.insert(pk.clone()) {
            let data_type = explicit_types.get(pk).cloned().unwrap_or(DataType::Int64);
            fields.push(Field::new(pk, data_type, false));
        }
    }

    // If explicit output columns are provided, use those
    if let Some(ref output_cols) = config.output_columns {
        for col in output_cols {
            if seen.insert(col.name.clone()) {
                let nullable = !config.pk_columns.contains(&col.name);
                let dt = parse_data_type(&col.data_type);
                fields.push(Field::new(&col.name, dt, nullable));
            }
        }
    } else {
        // Otherwise, infer from load specs: all non-PK columns as nullable
        for spec in &config.load_specs {
            for col in &spec.columns {
                if seen.insert(col.clone()) {
                    // Default to Utf8 for unknown types; the Parquet reader will
                    // provide the actual type from the file schema
                    fields.push(Field::new(col, DataType::Utf8, true));
                }
            }
        }
    }

    Schema::new(fields)
}

/// Build a schema for a specific load's projected columns.
fn build_load_schema(spec: &LoadSpec, output_schema: &Schema) -> Schema {
    let mut fields: Vec<Field> = Vec::new();

    // Include PK columns
    for pk in &spec.pk_columns {
        if let Ok(field) = output_schema.field_with_name(pk) {
            fields.push(field.clone());
        }
    }

    // Include this load's payload columns
    for col in &spec.columns {
        if let Ok(field) = output_schema.field_with_name(col) {
            fields.push(field.clone());
        }
    }

    Schema::new(fields)
}

fn parse_data_type(s: &str) -> DataType {
    match s {
        "int32" => DataType::Int32,
        "int64" => DataType::Int64,
        "float" => DataType::Float32,
        "double" => DataType::Float64,
        "boolean" => DataType::Boolean,
        "string" => DataType::Utf8,
        "binary" => DataType::Binary,
        "date" => DataType::Date32,
        "timestamp" => DataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, None),
        _ => DataType::Utf8,
    }
}
