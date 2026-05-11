use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{
    new_null_array, ArrayRef, Int64Array, RecordBatch, StringArray, UInt32Array,
};
use arrow::compute;
use arrow::datatypes::{DataType, Schema};

use crate::error::{Result, StitchError};
use crate::format::FamilyBucketReader;
use crate::types::{PkFilter, PkValue};

use super::Stitcher;

/// NaiveStitcher — read all loads for a bucket, hash-join in memory, emit stitched batches.
///
/// v1 default. Simple, correct, O(rows in one bucket) memory. No sort requirement.
/// FULL OUTER JOIN semantics: every PK from any load appears in the output.
///
/// Pipeline:
///   1. Scan each load, concat into one RecordBatch, build PK → row_idx map.
///   2. Determine column ownership from each reader's declared schema — no
///      data scan needed.
///   3. Union PKs across all loads; dedup via a borrow-only HashSet so we
///      don't clone every PK before sorting.
///   4. For each non-PK output column, gather the per-PK row indices and use
///      `arrow::compute::take` to materialise it in one shot — replaces the
///      old per-row downcast + HashMap-lookup + per-type branch.
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

const STITCH_BATCH_SIZE: usize = 4096;

impl Stitcher for NaiveStitcher {
    fn init(
        &mut self,
        readers: HashMap<String, Box<dyn FamilyBucketReader>>,
        pk_columns: Vec<String>,
        output_schema: Schema,
        pk_filter: Option<PkFilter>,
    ) -> Result<()> {
        let pk_col_name = pk_columns
            .first()
            .ok_or_else(|| StitchError::Other(anyhow::anyhow!("pk_columns must be non-empty")))?;

        // Phase 1: scan each load. Concat its batches once so column reads in
        // Phase 4 become a single `take` against a contiguous batch instead of
        // walking batch-of-batches per row. Build the per-load PK → row_idx
        // map alongside the scan.
        let mut load_scans: HashMap<String, RecordBatch> = HashMap::new();
        let mut load_pk_to_row: HashMap<String, HashMap<PkValue, u32>> = HashMap::new();

        for (load_id, reader) in &readers {
            let batches = reader.scan_data()?;
            if batches.is_empty() {
                load_pk_to_row.insert(load_id.clone(), HashMap::new());
                continue;
            }
            let schema = batches[0].schema();
            let full = compute::concat_batches(&schema, &batches)?;
            if full.num_rows() > u32::MAX as usize {
                return Err(StitchError::Other(anyhow::anyhow!(
                    "load '{}' has {} rows, exceeds the u32 take-index limit",
                    load_id,
                    full.num_rows()
                )));
            }

            let pk_array = full.column_by_name(pk_col_name).ok_or_else(|| {
                let schema_fields: Vec<String> = full
                    .schema()
                    .fields()
                    .iter()
                    .map(|f| f.name().clone())
                    .collect();
                StitchError::Other(anyhow::anyhow!(
                    "PK column '{}' not found in batch from load '{}'. Available columns: {:?}",
                    pk_col_name,
                    load_id,
                    schema_fields
                ))
            })?;

            let mut pk_map: HashMap<PkValue, u32> = HashMap::with_capacity(full.num_rows());
            for row_idx in 0..full.num_rows() {
                let pk_val = PkValue::from_array(pk_array.as_ref(), row_idx)?;
                if let Some(filter) = &pk_filter {
                    if !pk_val.matches_filter(filter) {
                        continue;
                    }
                }
                pk_map.insert(pk_val, row_idx as u32);
            }
            load_pk_to_row.insert(load_id.clone(), pk_map);
            load_scans.insert(load_id.clone(), full);
        }

        // Phase 2: column ownership from declared reader schemas. Previously
        // this walked the whole row-major `index` HashMap once per output
        // column — O(fields × loads × index_entries). The reader already
        // knows its schema; ask it.
        let output_fields = output_schema.fields();
        let mut load_for_column: Vec<Option<String>> = Vec::with_capacity(output_fields.len());
        for field in output_fields {
            let name = field.name();
            if pk_columns.contains(name) {
                load_for_column.push(None);
                continue;
            }
            let mut found = None;
            for (load_id, reader) in &readers {
                if reader.schema().field_with_name(name).is_ok() {
                    found = Some(load_id.clone());
                    break;
                }
            }
            load_for_column.push(found);
        }

        // Phase 3: union PKs. Borrow-only dedup so we don't clone every PK
        // String/Composite per load before sorting.
        let unique_pks: HashSet<&PkValue> = load_pk_to_row
            .values()
            .flat_map(|m| m.keys())
            .collect();
        let mut all_pks: Vec<PkValue> = unique_pks.into_iter().cloned().collect();
        all_pks.sort();

        if all_pks.is_empty() {
            self.output_schema = Some(output_schema);
            self.stitched_batches = Vec::new();
            self.current_batch = 0;
            return Ok(());
        }

        // Phase 4: emit batches of up to STITCH_BATCH_SIZE PKs. For each
        // non-PK column we gather the matching row indices for this chunk
        // and call `compute::take` — that's a single zero-copy
        // (or one-array-allocate) kernel call per column, replacing the
        // old per-row downcast match.
        let mut batches: Vec<RecordBatch> = Vec::new();
        let schema_arc = Arc::new(output_schema.clone());

        for chunk in all_pks.chunks(STITCH_BATCH_SIZE) {
            let mut columns: Vec<ArrayRef> = Vec::with_capacity(output_fields.len());

            for (field_idx, load_id_opt) in load_for_column.iter().enumerate() {
                let field = &output_fields[field_idx];
                let Some(load_id) = load_id_opt else {
                    // PK column — built from the dedup'd PkValue list directly.
                    columns.push(build_pk_array(field.data_type(), chunk)?);
                    continue;
                };

                let Some(pk_map) = load_pk_to_row.get(load_id.as_str()) else {
                    columns.push(new_null_array(field.data_type(), chunk.len()));
                    continue;
                };
                let Some(scan) = load_scans.get(load_id.as_str()) else {
                    columns.push(new_null_array(field.data_type(), chunk.len()));
                    continue;
                };
                let Some(src) = scan.column_by_name(field.name()) else {
                    // Reader schema said the field exists but the scanned
                    // batch didn't carry it — emit nulls rather than panicking.
                    columns.push(new_null_array(field.data_type(), chunk.len()));
                    continue;
                };

                let indices: Vec<Option<u32>> =
                    chunk.iter().map(|pk| pk_map.get(pk).copied()).collect();
                let index_array = UInt32Array::from(indices);
                let remapped = compute::take(src, &index_array, None)
                    .map_err(StitchError::Arrow)?;
                columns.push(remapped);
            }

            let batch = RecordBatch::try_new(schema_arc.clone(), columns)?;
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
