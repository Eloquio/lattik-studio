use thiserror::Error;

#[derive(Error, Debug)]
pub enum StitchError {
    #[error("Column '{column}' has no load for ds={ds}")]
    ColumnNotLoaded { column: String, ds: String },

    #[error("SELECT * requires stitching {load_count} loads (max allowed: {max}). Specify columns explicitly.")]
    TooManyLoads { load_count: usize, max: usize },

    #[error("Manifest not found: {path}")]
    ManifestNotFound { path: String },

    #[error("Load not found: {load_id}")]
    LoadNotFound { load_id: String },

    #[error("Bucket {bucket_id} not found in load {load_id}")]
    BucketNotFound { bucket_id: u32, load_id: String },

    #[error("Format '{format}' does not support {operation}")]
    UnsupportedOperation { format: String, operation: String },

    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),

    #[error("S3 error: {0}")]
    ObjectStore(#[from] object_store::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, StitchError>;
