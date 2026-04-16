mod reader;
mod session;
mod writer;

use std::sync::Arc;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::{FamilyBucketReader, FamilyFormat};
use lattik_stitch_core::types::S3Config;

/// Vortex implementation of FamilyFormat.
///
/// Write strategy: unsorted data + PK index sidecar (both in Vortex format).
/// Read strategy: sequential scan for full reads, PK index probe + random
/// access for point lookups (100x faster than Parquet).
pub struct VortexFormat;

impl FamilyFormat for VortexFormat {
    fn id(&self) -> &str {
        "vortex"
    }

    fn supports_random_access(&self) -> bool {
        true
    }

    fn open_bucket(
        &self,
        bucket_path: &str,
        schema: &Schema,
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<Box<dyn FamilyBucketReader>> {
        Ok(Box::new(reader::VortexBucketReader::new(
            bucket_path.to_string(),
            schema.clone(),
            pk_columns.to_vec(),
            s3_config.clone(),
        )))
    }

    fn write_bucket_with_index(
        &self,
        bucket_path: &str,
        batches: Vec<RecordBatch>,
        schema: &Schema,
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<()> {
        writer::write_vortex_bucket_with_index(
            bucket_path, &batches, schema, pk_columns, s3_config,
        )
    }

    fn write_bucket(
        &self,
        _bucket_path: &str,
        _batches: Vec<RecordBatch>,
        _schema: &Schema,
        _s3_config: &S3Config,
    ) -> Result<()> {
        Err(StitchError::UnsupportedOperation {
            format: "vortex".to_string(),
            operation: "write_bucket without index (Vortex always writes with PK index)".to_string(),
        })
    }
}
