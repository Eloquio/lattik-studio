use serde::{Deserialize, Serialize};
use arrow::array::{Array, Int64Array, StringArray};
use arrow::datatypes::DataType;

use crate::error::{Result, StitchError};

/// S3 connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// PK filter predicate pushed down from the query engine.
#[derive(Debug, Clone)]
pub enum PkFilter {
    /// Exact match: WHERE user_id = 42
    Eq(PkValue),
    /// IN list: WHERE user_id IN (1, 2, 3)
    In(Vec<PkValue>),
    /// Range: WHERE user_id BETWEEN 10 AND 100
    Range { min: PkValue, max: PkValue },
}

/// A single PK value (supports the types entities typically use).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PkValue {
    Int64(i64),
    Utf8(String),
}

impl PkValue {
    pub fn from_array(array: &dyn Array, row_idx: usize) -> Result<Self> {
        if array.is_null(row_idx) {
            return Err(StitchError::Other(anyhow::anyhow!(
                "NULL primary keys are not supported"
            )));
        }

        match array.data_type() {
            DataType::Int64 => {
                let values = array
                    .as_any()
                    .downcast_ref::<Int64Array>()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("PK column is not Int64")))?;
                Ok(Self::Int64(values.value(row_idx)))
            }
            DataType::Utf8 => {
                let values = array
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("PK column is not Utf8")))?;
                Ok(Self::Utf8(values.value(row_idx).to_string()))
            }
            other => Err(StitchError::Other(anyhow::anyhow!(
                "Unsupported PK data type: {other:?}"
            ))),
        }
    }

    pub fn matches_filter(&self, filter: &PkFilter) -> bool {
        match filter {
            PkFilter::Eq(value) => self == value,
            PkFilter::In(values) => values.iter().any(|value| value == self),
            PkFilter::Range { min, max } => self >= min && self <= max,
        }
    }
}

/// Self-describing metadata for a single load, stored as `load.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadMetadata {
    pub load_id: String,
    pub timestamp: String,
    pub ds: String,
    pub hour: Option<u32>,
    pub mode: LoadMode,
    pub format: String,
    pub bucket_levels: Vec<u32>,
    pub bucket_count: u32,
    pub sorted: bool,
    pub has_pk_index: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadMode {
    Forward,
    Backfill,
}

/// Table manifest — a single column→load_id mapping. Immutable on S3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u64,
    pub columns: std::collections::HashMap<String, String>,
}

/// Spec for one load's partition within a stitch operation.
#[derive(Debug, Clone)]
pub struct LoadPartitionSpec {
    /// S3 path to the bucket directory (e.g., "s3://.../loads/<uuid>/bucket=0042/")
    pub path: String,
    /// Load ID
    pub load_id: String,
    /// Columns needed from this load
    pub columns: Vec<String>,
    /// PK column names
    pub pk_columns: Vec<String>,
    /// File format (from load.json)
    pub format_id: String,
    /// Whether data is sorted by PK
    pub sorted: bool,
    /// Whether a PK index sidecar exists
    pub has_pk_index: bool,
}
