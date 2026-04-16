use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, BinaryArray, BooleanArray, Float32Array, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray};
use arrow::datatypes::{DataType, Schema};

use crate::error::{Result, StitchError};
use crate::format::FamilyBucketReader;
use crate::types::{PkFilter, PkValue};

use super::Stitcher;

/// NaiveStitcher — read all loads for a bucket, hash-join in memory, emit stitched batches.
///
/// v1 default. Simple, correct, O(rows in one bucket) memory. No sort requirement.
/// FULL OUTER JOIN semantics: every PK from any load appears in the output.
pub struct NaiveStitcher {
    output_schema: Option<Schema>,
    stitched_batches: Vec<RecordBatch>,
    current_batch: usize,
}

impl NaiveStitcher {
    pub fn new() -> Self {
        Self {
            output_schema: None,
            stitched_batches: Vec::new(),
            current_batch: 0,
        }
    }
}

impl Default for NaiveStitcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Stitcher for NaiveStitcher {
    fn init(
        &mut self,
        readers: HashMap<String, Box<dyn FamilyBucketReader>>,
        pk_columns: Vec<String>,
        output_schema: Schema,
        pk_filter: Option<PkFilter>,
    ) -> Result<()> {
        // Phase 1: Read all loads, index by PK.
        // pk_value → (load_id → (batch, row_idx))
        let mut index: HashMap<PkValue, HashMap<String, (RecordBatch, usize)>> = HashMap::new();

        for (load_id, reader) in &readers {
            let batches = reader.scan_data()?;
            for batch in batches {
                let pk_col = batch.column_by_name(&pk_columns[0]).ok_or_else(|| {
                    let schema_fields: Vec<String> = batch
                        .schema()
                        .fields()
                        .iter()
                        .map(|f| f.name().clone())
                        .collect();
                    StitchError::Other(anyhow::anyhow!(
                        "PK column '{}' not found in batch from load '{}'. Available columns: {:?}",
                        pk_columns[0],
                        load_id,
                        schema_fields
                    ))
                })?;

                for row_idx in 0..batch.num_rows() {
                    let pk_val = PkValue::from_array(pk_col.as_ref(), row_idx)?;
                    if let Some(filter) = &pk_filter {
                        if !pk_val.matches_filter(filter) {
                            continue;
                        }
                    }
                    index
                        .entry(pk_val)
                        .or_default()
                        .insert(load_id.clone(), (batch.clone(), row_idx));
                }
            }
        }

        // Phase 2: Build stitched batches.
        let batch_size = 4096;
        let mut all_pks: Vec<PkValue> = index.keys().cloned().collect();
        all_pks.sort();

        // Collect output column builders info: for each output field, which load has it?
        let output_fields = output_schema.fields();
        let mut load_column_map: Vec<(String, Option<String>)> = Vec::new(); // (field_name, load_id or None for PK)

        for field in output_fields {
            let name = field.name();
            if pk_columns.contains(name) {
                load_column_map.push((name.clone(), None)); // PK column
            } else {
                // Find which load has this column
                let mut found_load = None;
                for (load_id, reader_) in &readers {
                    let _ = reader_; // We find the load from the index data
                    // Check if any batch in the index has this column from this load
                    for (_, load_map) in &index {
                        if let Some((batch, _)) = load_map.get(load_id.as_str()) {
                            if batch.schema().field_with_name(name).is_ok() {
                                found_load = Some(load_id.clone());
                                break;
                            }
                        }
                    }
                    if found_load.is_some() {
                        break;
                    }
                }
                load_column_map.push((name.clone(), found_load));
            }
        }

        // Build batches in chunks of batch_size
        let mut batches = Vec::new();
        for chunk in all_pks.chunks(batch_size) {
            let mut columns: Vec<ArrayRef> = Vec::new();

            for (field_idx, (field_name, load_id)) in load_column_map.iter().enumerate() {
                let field = &output_fields[field_idx];

                if load_id.is_none() {
                    // PK column
                    columns.push(build_pk_array(field.data_type(), chunk)?);
                } else {
                    let load_id = load_id.as_ref().unwrap();
                    // Build array for this column from the index
                    match field.data_type() {
                        DataType::Int64 => {
                            let values: Vec<Option<i64>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch
                                                .column_by_name(field_name)
                                                .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' not found in batch", field_name)))
                                                .and_then(|col| {
                                                    col.as_any()
                                                        .downcast_ref::<Int64Array>()
                                                        .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' is not Int64", field_name)))
                                                        .map(|arr| arr.value(*row_idx))
                                                })
                                                .ok()
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(Int64Array::from(values)));
                        }
                        DataType::Float64 => {
                            let values: Vec<Option<f64>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch
                                                .column_by_name(field_name)
                                                .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' not found in batch", field_name)))
                                                .and_then(|col| {
                                                    col.as_any()
                                                        .downcast_ref::<Float64Array>()
                                                        .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' is not Float64", field_name)))
                                                        .map(|arr| arr.value(*row_idx))
                                                })
                                                .ok()
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(Float64Array::from(values)));
                        }
                        DataType::Utf8 => {
                            let values: Vec<Option<String>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch
                                                .column_by_name(field_name)
                                                .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' not found in batch", field_name)))
                                                .and_then(|col| {
                                                    col.as_any()
                                                        .downcast_ref::<StringArray>()
                                                        .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column '{}' is not Utf8", field_name)))
                                                        .map(|arr| arr.value(*row_idx).to_string())
                                                })
                                                .ok()
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(StringArray::from(values)));
                        }
                        DataType::Int32 => {
                            let values: Vec<Option<i32>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch.column_by_name(field_name).and_then(|col| {
                                                col.as_any()
                                                    .downcast_ref::<Int32Array>()
                                                    .map(|arr| arr.value(*row_idx))
                                            })
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(Int32Array::from(values)));
                        }
                        DataType::Float32 => {
                            let values: Vec<Option<f32>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch.column_by_name(field_name).and_then(|col| {
                                                col.as_any()
                                                    .downcast_ref::<Float32Array>()
                                                    .map(|arr| arr.value(*row_idx))
                                            })
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(Float32Array::from(values)));
                        }
                        DataType::Boolean => {
                            let values: Vec<Option<bool>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch.column_by_name(field_name).and_then(|col| {
                                                col.as_any()
                                                    .downcast_ref::<BooleanArray>()
                                                    .map(|arr| arr.value(*row_idx))
                                            })
                                        },
                                    )
                                })
                                .collect();
                            columns.push(Arc::new(BooleanArray::from(values)));
                        }
                        DataType::Binary => {
                            let values: Vec<Option<Vec<u8>>> = chunk
                                .iter()
                                .map(|pk| {
                                    index.get(pk).and_then(|m| m.get(load_id.as_str())).and_then(
                                        |(batch, row_idx)| {
                                            batch.column_by_name(field_name).and_then(|col| {
                                                col.as_any()
                                                    .downcast_ref::<BinaryArray>()
                                                    .map(|arr| arr.value(*row_idx).to_vec())
                                            })
                                        },
                                    )
                                })
                                .collect();
                            let refs: Vec<Option<&[u8]>> =
                                values.iter().map(|value| value.as_deref()).collect();
                            columns.push(Arc::new(BinaryArray::from(refs)));
                        }
                        dt => {
                            // For unhandled types, emit a typed null array
                            columns.push(arrow::array::new_null_array(dt, chunk.len()));
                        }
                    }
                }
            }

            let batch = RecordBatch::try_new(Arc::new(output_schema.clone()), columns)?;
            batches.push(batch);
        }

        self.output_schema = Some(output_schema);
        self.stitched_batches = batches;
        self.current_batch = 0;
        Ok(())
    }

    fn has_next(&self) -> bool {
        self.current_batch < self.stitched_batches.len()
    }

    fn next_batch(&mut self) -> Result<RecordBatch> {
        let batch = self.stitched_batches[self.current_batch].clone();
        self.current_batch += 1;
        Ok(batch)
    }
}

fn build_pk_array(data_type: &DataType, values: &[PkValue]) -> Result<ArrayRef> {
    match data_type {
        DataType::Int64 => {
            let ints: Result<Vec<i64>> = values
                .iter()
                .map(|value| match value {
                    PkValue::Int64(v) => Ok(*v),
                    other => Err(StitchError::Other(anyhow::anyhow!(
                        "Expected Int64 PK, found {other:?}"
                    ))),
                })
                .collect();
            Ok(Arc::new(Int64Array::from(ints?)))
        }
        DataType::Utf8 => {
            let strings: Result<Vec<String>> = values
                .iter()
                .map(|value| match value {
                    PkValue::Utf8(v) => Ok(v.clone()),
                    other => Err(StitchError::Other(anyhow::anyhow!(
                        "Expected Utf8 PK, found {other:?}"
                    ))),
                })
                .collect();
            Ok(Arc::new(StringArray::from(strings?)))
        }
        other => Err(StitchError::Other(anyhow::anyhow!(
            "Unsupported PK output type: {other:?}"
        ))),
    }
}
