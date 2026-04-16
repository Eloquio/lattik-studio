use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{new_null_array, ArrayRef, Int64Array, RecordBatch, StringArray, UInt32Array};
use arrow::compute;
use arrow::datatypes::{DataType, Schema};

use crate::error::{Result, StitchError};
use crate::format::FamilyBucketReader;
use crate::types::{PkFilter, PkValue};

use super::Stitcher;

/// IndexedStitcher — zero-copy PK index probe + random access.
///
/// For each load with a PK index:
/// 1. Probe the index with the PK filter → get matching (pk, row_id) pairs
/// 2. Compute union PKs and per-load mapping vectors
/// 3. Random-access fetch from each load's data file
/// 4. Assemble output RecordBatch using take() with index remapping
///
/// For loads without a PK index (Parquet): falls back to scan_data()
/// with post-scan PK filtering.
pub struct IndexedStitcher {
    output_schema: Option<Schema>,
    stitched_batches: Vec<RecordBatch>,
    current_batch: usize,
}

impl IndexedStitcher {
    pub fn new() -> Self {
        Self {
            output_schema: None,
            stitched_batches: Vec::new(),
            current_batch: 0,
        }
    }
}

impl Default for IndexedStitcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Stitcher for IndexedStitcher {
    fn init(
        &mut self,
        readers: HashMap<String, Box<dyn FamilyBucketReader>>,
        pk_columns: Vec<String>,
        output_schema: Schema,
        pk_filter: Option<PkFilter>,
    ) -> Result<()> {
        let pk_filter = pk_filter.ok_or_else(|| {
            crate::error::StitchError::Other(anyhow::anyhow!(
                "IndexedStitcher requires a PK filter"
            ))
        })?;

        let pk_col_name = &pk_columns[0];

        // Phase 1: Probe each load's PK index (or scan for non-indexed loads).
        // For non-indexed loads, we also cache the concatenated scanned batch
        // so Phase 3 can fetch columns via arrow::compute::take without re-scanning.
        let mut load_matches: HashMap<String, Vec<(PkValue, u64)>> = HashMap::new();
        let mut load_scans: HashMap<String, RecordBatch> = HashMap::new();

        for (load_id, reader) in &readers {
            if reader.has_pk_index() {
                // Index probe — uses zone maps for efficient filtering
                let matches = reader.probe_index(&pk_filter)?;
                load_matches.insert(load_id.clone(), matches);
            } else {
                // Fallback: scan all data, concat into one batch, filter by PK,
                // and cache the full batch so Phase 3 can take() columns from it.
                let batches = reader.scan_data()?;
                if batches.is_empty() {
                    load_matches.insert(load_id.clone(), Vec::new());
                    continue;
                }
                let schema = batches[0].schema();
                let full = arrow::compute::concat_batches(&schema, &batches)?;

                let pk_array = full
                    .column_by_name(pk_col_name)
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("PK column not found")))?;

                let mut matches = Vec::new();
                for i in 0..full.num_rows() {
                    let pk_val = PkValue::from_array(pk_array.as_ref(), i)?;
                    if pk_val.matches_filter(&pk_filter) {
                        matches.push((pk_val, i as u64));
                    }
                }
                load_matches.insert(load_id.clone(), matches);
                load_scans.insert(load_id.clone(), full);
            }
        }

        // Phase 2: Compute union PKs
        let mut all_pks: Vec<PkValue> = load_matches
            .values()
            .flat_map(|matches| matches.iter().map(|(pk, _)| pk.clone()))
            .collect();
        all_pks.sort();
        all_pks.dedup();

        if all_pks.is_empty() {
            self.output_schema = Some(output_schema);
            self.stitched_batches = Vec::new();
            return Ok(());
        }

        // Phase 3: Fetch rows from each load and build per-load mapping
        let output_fields = output_schema.fields();
        let mut columns: Vec<ArrayRef> = Vec::new();

        // Determine which load provides which output column, using each reader's
        // declared schema (no scan or fetch needed).
        let mut load_for_column: Vec<Option<String>> = Vec::new();
        for field in output_fields {
            if pk_columns.contains(field.name()) {
                load_for_column.push(None); // PK
            } else {
                let mut found = None;
                for (load_id, reader) in &readers {
                    if reader.schema().field_with_name(field.name()).is_ok() {
                        found = Some(load_id.clone());
                        break;
                    }
                }
                load_for_column.push(found);
            }
        }

        // Build PK column
        columns.push(build_pk_array(&output_fields[0].data_type().clone(), &all_pks)?);

        // For each non-PK column, fetch from the appropriate load
        // and remap to match the union PK order
        for (field_idx, load_id_opt) in load_for_column.iter().enumerate().skip(pk_columns.len()) {
            let field = &output_fields[field_idx];
            let Some(load_id) = load_id_opt else {
                columns.push(new_null_array(field.data_type(), all_pks.len()));
                continue;
            };

            let matches = load_matches
                .get(load_id.as_str())
                .cloned()
                .unwrap_or_default();
            let load_pk_to_rid: HashMap<PkValue, u64> = matches.into_iter().collect();
            let reader = readers
                .get(load_id.as_str())
                .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Reader not found for load {}", load_id)))?;

            if reader.has_pk_index() {
                // Indexed path: random-access fetch by row_id
                let row_ids: Vec<u64> = all_pks
                    .iter()
                    .filter_map(|pk| load_pk_to_rid.get(pk).copied())
                    .collect();

                if row_ids.is_empty() {
                    columns.push(new_null_array(field.data_type(), all_pks.len()));
                    continue;
                }

                let fetched = reader.fetch_rows(&row_ids, &output_schema)?;
                let col = fetched
                    .column_by_name(field.name())
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column not found in fetched batch")))?;

                // Build index mapping: for each union PK, either its position in
                // the fetched batch or None (load didn't have it).
                let mut fetch_idx = 0usize;
                let mut indices: Vec<Option<u32>> = Vec::with_capacity(all_pks.len());
                for pk in &all_pks {
                    if load_pk_to_rid.contains_key(pk) {
                        indices.push(Some(fetch_idx as u32));
                        fetch_idx += 1;
                    } else {
                        indices.push(None);
                    }
                }

                let index_array = UInt32Array::from(indices);
                let remapped = compute::take(col, &index_array, None)
                    .map_err(|e| crate::error::StitchError::Arrow(e))?;
                columns.push(remapped);
            } else {
                // Non-indexed path: take() from the cached scanned batch.
                let full = load_scans
                    .get(load_id.as_str())
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("non-indexed load must have a cached scan")))?;
                let col = full
                    .column_by_name(field.name())
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("Column not found in scanned batch")))?;

                // For each union PK, find the row index in the full scan,
                // or None if this load doesn't have that PK.
                let indices: Vec<Option<u32>> = all_pks
                    .iter()
                    .map(|pk| load_pk_to_rid.get(pk).map(|&rid| rid as u32))
                    .collect();

                let index_array = UInt32Array::from(indices);
                let remapped = compute::take(col, &index_array, None)
                    .map_err(|e| crate::error::StitchError::Arrow(e))?;
                columns.push(remapped);
            }
        }

        let batch = RecordBatch::try_new(Arc::new(output_schema.clone()), columns)?;
        self.output_schema = Some(output_schema);
        self.stitched_batches = vec![batch];
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
