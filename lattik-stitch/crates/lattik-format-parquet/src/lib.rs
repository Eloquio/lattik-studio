mod reader;
mod store;
mod writer;

use std::sync::Arc;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::{FamilyBucketReader, FamilyFormat};
use lattik_stitch_core::types::S3Config;

/// Parquet implementation of FamilyFormat.
///
/// Write strategy: data sorted by PK, no sidecar index.
/// Read strategy: sequential scan with sorted-data guarantees.
/// No random access / PK index support — Parquet requires block decompression.
pub struct ParquetFormat;

impl FamilyFormat for ParquetFormat {
    fn id(&self) -> &str {
        "parquet"
    }

    fn supports_random_access(&self) -> bool {
        false
    }

    fn open_bucket(
        &self,
        bucket_path: &str,
        schema: &Schema,
        _pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<Box<dyn FamilyBucketReader>> {
        let object_store = store::build_s3_store(s3_config)?;
        Ok(Box::new(reader::ParquetBucketReader::new(
            object_store,
            bucket_path.to_string(),
            schema.clone(),
        )))
    }

    fn write_bucket_with_index(
        &self,
        _bucket_path: &str,
        _batches: Vec<RecordBatch>,
        _schema: &Schema,
        _pk_columns: &[String],
        _s3_config: &S3Config,
    ) -> Result<()> {
        Err(StitchError::UnsupportedOperation {
            format: "parquet".to_string(),
            operation: "write_bucket_with_index (no PK index for Parquet)".to_string(),
        })
    }

    fn write_bucket(
        &self,
        bucket_path: &str,
        batches: Vec<RecordBatch>,
        schema: &Schema,
        s3_config: &S3Config,
    ) -> Result<()> {
        let object_store = store::build_s3_store(s3_config)?;
        writer::write_parquet_bucket(&object_store, bucket_path, &batches, schema)
    }
}

/// Create a ParquetBucketReader with an injected ObjectStore (for testing).
pub fn open_bucket_with_store(
    store: Arc<dyn object_store::ObjectStore>,
    bucket_path: &str,
    schema: &Schema,
) -> Box<dyn FamilyBucketReader> {
    Box::new(reader::ParquetBucketReader::new(
        store,
        bucket_path.to_string(),
        schema.clone(),
    ))
}

/// Write a Parquet bucket with an injected ObjectStore (for testing).
pub fn write_bucket_with_store(
    store: &Arc<dyn object_store::ObjectStore>,
    bucket_path: &str,
    batches: &[RecordBatch],
    schema: &Schema,
) -> Result<()> {
    writer::write_parquet_bucket(store, bucket_path, batches, schema)
}
