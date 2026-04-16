use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::types::{PkFilter, PkValue, S3Config};

/// Reads and writes columnar data for one load's bucket.
/// Implementations wrap a specific file format (Parquet, Vortex, Lance, etc.).
pub trait FamilyFormat: Send + Sync {
    /// Unique identifier (e.g., "parquet", "lance", "vortex").
    fn id(&self) -> &str;

    /// Whether this format supports fast random access (→ PK index sidecar).
    fn supports_random_access(&self) -> bool;

    /// Open a bucket for reading.
    fn open_bucket(
        &self,
        bucket_path: &str,
        schema: &Schema,
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<Box<dyn FamilyBucketReader>>;

    /// Write data + PK index for one bucket (Vortex, Lance).
    fn write_bucket_with_index(
        &self,
        bucket_path: &str,
        batches: Vec<RecordBatch>,
        schema: &Schema,
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<()>;

    /// Write data only, no PK index, for one bucket (Parquet — caller pre-sorts).
    fn write_bucket(
        &self,
        bucket_path: &str,
        batches: Vec<RecordBatch>,
        schema: &Schema,
        s3_config: &S3Config,
    ) -> Result<()>;
}

/// Handle for reading a single load's bucket. Provides sequential scan
/// and optionally indexed access.
pub trait FamilyBucketReader: Send {
    /// The columns this load was written with. Used by the stitcher to
    /// decide which load owns which output column without touching data.
    fn schema(&self) -> &Schema;

    /// Whether this load has sorted data (Parquet).
    fn is_sorted(&self) -> bool;

    /// Whether this load has a PK index sidecar (Vortex, Lance).
    fn has_pk_index(&self) -> bool;

    /// Sequential scan. Returns all rows in storage/sort order.
    fn scan_data(&self) -> Result<Vec<RecordBatch>>;

    /// Probe the PK index for specific keys (only if has_pk_index()).
    fn probe_index(&self, predicate: &PkFilter) -> Result<Vec<(PkValue, u64)>>;

    /// Random-access read by row_id (only if has_pk_index()).
    /// Returned RecordBatch buffers must remain valid for zero-copy stitching.
    fn fetch_rows(&self, row_ids: &[u64], schema: &Schema) -> Result<RecordBatch>;
}
