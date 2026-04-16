use std::sync::Arc;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;
use object_store::path::Path;
use object_store::{ObjectStore, ObjectStoreExt};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ProjectionMask;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::FamilyBucketReader;
use lattik_stitch_core::types::{PkFilter, PkValue};

/// Parquet bucket reader — sequential scan of sorted Parquet data.
/// No PK index, no random access.
///
/// Lists all `.parquet` files in the bucket directory and reads them
/// sequentially. Supports both `data.parquet` (Lattik native layout)
/// and `part-*.parquet` (Spark default writer layout).
pub struct ParquetBucketReader {
    store: Arc<dyn ObjectStore>,
    bucket_path: String,
    schema: Schema,
}

impl ParquetBucketReader {
    pub fn new(store: Arc<dyn ObjectStore>, bucket_path: String, schema: Schema) -> Self {
        Self {
            store,
            bucket_path,
            schema,
        }
    }

    /// List all Parquet files in the bucket directory.
    fn list_parquet_files(&self) -> Result<Vec<Path>> {
        let prefix = Path::from(self.bucket_path.clone());
        let store = self.store.clone();

        let paths = match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| {
                handle.block_on(async {
                    let mut paths = Vec::new();
                    let list = store.list(Some(&prefix));
                    use futures::TryStreamExt;
                    let objects: Vec<_> = list.try_collect().await?;
                    for obj in objects {
                        let key = obj.location.to_string();
                        if key.ends_with(".parquet") && !key.contains("_SUCCESS") {
                            paths.push(obj.location);
                        }
                    }
                    Ok::<_, object_store::Error>(paths)
                })
            }),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async {
                    let mut paths = Vec::new();
                    let list = store.list(Some(&prefix));
                    use futures::TryStreamExt;
                    let objects: Vec<_> = list.try_collect().await?;
                    for obj in objects {
                        let key = obj.location.to_string();
                        if key.ends_with(".parquet") && !key.contains("_SUCCESS") {
                            paths.push(obj.location);
                        }
                    }
                    Ok::<_, object_store::Error>(paths)
                })
            }
        }
        .map_err(StitchError::ObjectStore)?;

        Ok(paths)
    }

    /// Read a single Parquet file and return its RecordBatches.
    fn read_parquet_file(&self, path: &Path) -> Result<Vec<RecordBatch>> {
        let store = self.store.clone();
        let path = path.clone();

        let bytes = match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| {
                handle.block_on(async {
                    let result = store.get(&path).await?;
                    result.bytes().await
                })
            }),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async {
                    let result = store.get(&path).await?;
                    result.bytes().await
                })
            }
        }
        .map_err(StitchError::ObjectStore)?;

        // Project to only the columns in our schema.
        let projected_fields: Vec<String> = self
            .schema
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();

        let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)
            .map_err(|e| StitchError::Other(e.into()))?;

        let arrow_schema = builder.schema().clone();
        let column_indices: Vec<usize> = projected_fields
            .iter()
            .filter_map(|name| arrow_schema.index_of(name).ok())
            .collect();

        let mask = ProjectionMask::roots(builder.parquet_schema(), column_indices);

        let reader = builder
            .with_projection(mask)
            .with_batch_size(4096)
            .build()
            .map_err(|e| StitchError::Other(e.into()))?;

        let mut batches = Vec::new();
        for batch_result in reader {
            let batch = batch_result.map_err(|e| StitchError::Other(e.into()))?;
            batches.push(batch);
        }

        Ok(batches)
    }
}

impl FamilyBucketReader for ParquetBucketReader {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn is_sorted(&self) -> bool {
        true
    }

    fn has_pk_index(&self) -> bool {
        false
    }

    fn scan_data(&self) -> Result<Vec<RecordBatch>> {
        // List all Parquet files in the bucket directory
        let parquet_files = self.list_parquet_files()?;

        if parquet_files.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "No Parquet files found in bucket path '{}'. S3 listing returned no .parquet files.",
                self.bucket_path
            )));
        }

        tracing::debug!(
            path = %self.bucket_path,
            num_files = parquet_files.len(),
            "ParquetBucketReader::scan_data"
        );

        // Read all Parquet files and concatenate their batches
        let mut all_batches = Vec::new();
        for file_path in &parquet_files {
            let batches = self.read_parquet_file(file_path)?;
            all_batches.extend(batches);
        }

        tracing::debug!(
            path = %self.bucket_path,
            num_batches = all_batches.len(),
            total_rows = all_batches.iter().map(|b| b.num_rows()).sum::<usize>(),
            "ParquetBucketReader::scan_data complete"
        );

        Ok(all_batches)
    }

    fn probe_index(&self, _predicate: &PkFilter) -> Result<Vec<(PkValue, u64)>> {
        Err(StitchError::UnsupportedOperation {
            format: "parquet".to_string(),
            operation: "probe_index".to_string(),
        })
    }

    fn fetch_rows(&self, _row_ids: &[u64], _schema: &Schema) -> Result<RecordBatch> {
        Err(StitchError::UnsupportedOperation {
            format: "parquet".to_string(),
            operation: "fetch_rows".to_string(),
        })
    }
}
