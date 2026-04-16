pub mod indexed;
pub mod naive;

use std::collections::HashMap;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::format::FamilyBucketReader;
use crate::types::PkFilter;

/// Combines data from N load bucket readers into stitched Arrow RecordBatches.
pub trait Stitcher: Send {
    /// Initialize the stitcher with the load readers for one bucket.
    fn init(
        &mut self,
        readers: HashMap<String, Box<dyn FamilyBucketReader>>,
        pk_columns: Vec<String>,
        output_schema: Schema,
        pk_filter: Option<PkFilter>,
    ) -> Result<()>;

    /// Returns true if another stitched batch is available.
    fn has_next(&self) -> bool;

    /// Returns the next stitched RecordBatch (PK columns + all load columns).
    fn next_batch(&mut self) -> Result<RecordBatch>;
}
