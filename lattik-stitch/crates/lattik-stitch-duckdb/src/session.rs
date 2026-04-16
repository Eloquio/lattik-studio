//! StitchSession — wraps a Stitcher and produces Arrow RecordBatches.
//! This is the same session logic used in the JNI bridge, but without any
//! JVM or FFI types. The DuckDB VTab calls it directly.

use std::collections::HashMap;

use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::{FamilyBucketReader, FamilyFormat};
use lattik_stitch_core::stitcher::Stitcher;
use lattik_stitch_core::stitcher::indexed::IndexedStitcher;
use lattik_stitch_core::stitcher::naive::NaiveStitcher;
use lattik_stitch_core::types::{PkFilter, PkValue, S3Config};

use lattik_format_parquet::ParquetFormat;
use lattik_format_vortex::VortexFormat;

// ---------------------------------------------------------------------------
// Config types (serde for the resolve→session JSON round-trip)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SessionConfig {
    pub load_specs: Vec<LoadSpec>,
    pub pk_columns: Vec<String>,
    pub stitcher_id: String,
    pub output_columns: Option<Vec<OutputColumn>>,
    pub pk_filter: Option<PkFilterSpec>,
    pub s3_config: S3Config,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PkFilterSpec {
    pub filter_type: String,
    pub values: Option<Vec<serde_json::Value>>,
    pub min: Option<serde_json::Value>,
    pub max: Option<serde_json::Value>,
}

impl PkFilterSpec {
    fn to_pk_filter(&self) -> Result<PkFilter> {
        match self.filter_type.as_str() {
            "eq" => {
                let val = self
                    .values
                    .as_ref()
                    .and_then(|v| v.first())
                    .ok_or_else(|| {
                        StitchError::Other(anyhow::anyhow!("eq filter requires a value"))
                    })?;
                Ok(PkFilter::Eq(json_to_pk_value(val)?))
            }
            "in" => {
                let vals = self.values.as_ref().ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!("in filter requires values"))
                })?;
                let pk_vals: Result<Vec<PkValue>> = vals.iter().map(json_to_pk_value).collect();
                Ok(PkFilter::In(pk_vals?))
            }
            "range" => {
                let min = self.min.as_ref().ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!("range filter requires min"))
                })?;
                let max = self.max.as_ref().ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!("range filter requires max"))
                })?;
                Ok(PkFilter::Range {
                    min: json_to_pk_value(min)?,
                    max: json_to_pk_value(max)?,
                })
            }
            other => Err(StitchError::Other(anyhow::anyhow!(
                "Unsupported filter type: {other}"
            ))),
        }
    }
}

fn json_to_pk_value(v: &serde_json::Value) -> Result<PkValue> {
    if let Some(n) = v.as_i64() {
        Ok(PkValue::Int64(n))
    } else if let Some(s) = v.as_str() {
        Ok(PkValue::Utf8(s.to_string()))
    } else {
        Err(StitchError::Other(anyhow::anyhow!(
            "Unsupported PK value type: {v}"
        )))
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct LoadSpec {
    pub load_id: String,
    pub path: String,
    pub columns: Vec<String>,
    pub pk_columns: Vec<String>,
    pub format_id: String,
    pub sorted: bool,
    pub has_pk_index: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OutputColumn {
    pub name: String,
    pub data_type: String,
}

// ---------------------------------------------------------------------------
// StitchSession
// ---------------------------------------------------------------------------

pub struct StitchSession {
    stitcher: Box<dyn Stitcher>,
    output_schema: Schema,
}

impl StitchSession {
    /// Create a session from a resolved SessionConfig.
    pub fn from_config(config: SessionConfig) -> Result<Self> {
        if config.load_specs.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "Session config must include at least one load"
            )));
        }

        let output_schema = build_output_schema(&config);

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

            readers.insert(spec.load_id.clone(), reader);
        }

        let pk_filter = config
            .pk_filter
            .as_ref()
            .map(|spec| spec.to_pk_filter())
            .transpose()?;

        let mut stitcher: Box<dyn Stitcher> = match config.stitcher_id.as_str() {
            "naive" => Box::new(NaiveStitcher::new()),
            "indexed" => Box::new(IndexedStitcher::new()),
            other => {
                return Err(StitchError::Other(anyhow::anyhow!(
                    "Unknown stitcher: {other}"
                )))
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

    pub fn output_schema(&self) -> &Schema {
        &self.output_schema
    }

    pub fn has_next(&self) -> bool {
        self.stitcher.has_next()
    }

    pub fn next_batch(&mut self) -> Result<RecordBatch> {
        self.stitcher.next_batch()
    }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

fn build_output_schema(config: &SessionConfig) -> Schema {
    let mut fields: Vec<Field> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let explicit_types: HashMap<String, DataType> = config
        .output_columns
        .as_ref()
        .map(|columns| {
            columns
                .iter()
                .map(|column| (column.name.clone(), parse_data_type(&column.data_type)))
                .collect()
        })
        .unwrap_or_default();

    for pk in &config.pk_columns {
        if seen.insert(pk.clone()) {
            let data_type = explicit_types.get(pk).cloned().unwrap_or(DataType::Int64);
            fields.push(Field::new(pk, data_type, false));
        }
    }

    if let Some(ref output_cols) = config.output_columns {
        for col in output_cols {
            if seen.insert(col.name.clone()) {
                let nullable = !config.pk_columns.contains(&col.name);
                let dt = parse_data_type(&col.data_type);
                fields.push(Field::new(&col.name, dt, nullable));
            }
        }
    } else {
        for spec in &config.load_specs {
            for col in &spec.columns {
                if seen.insert(col.clone()) {
                    fields.push(Field::new(col, DataType::Utf8, true));
                }
            }
        }
    }

    Schema::new(fields)
}

fn build_load_schema(spec: &LoadSpec, output_schema: &Schema) -> Schema {
    let mut fields: Vec<Field> = Vec::new();

    for pk in &spec.pk_columns {
        if let Ok(field) = output_schema.field_with_name(pk) {
            fields.push(field.clone());
        }
    }

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
        "timestamp" => DataType::Timestamp(TimeUnit::Microsecond, None),
        _ => DataType::Utf8,
    }
}
