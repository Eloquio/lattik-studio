use std::sync::Arc;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;
use object_store::path::Path;
use object_store::aws::AmazonS3Builder;
use object_store::{ObjectStore, ObjectStoreExt};

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::format::FamilyBucketReader;
use lattik_stitch_core::types::{PkFilter, PkValue, S3Config};

use crate::session::make_session;

/// Vortex bucket reader — supports both sequential scan and PK index-based
/// random access for point lookups.
pub struct VortexBucketReader {
    bucket_path: String,
    schema: Schema,
    pk_columns: Vec<String>,
    s3_config: S3Config,
}

impl VortexBucketReader {
    pub fn new(
        bucket_path: String,
        schema: Schema,
        pk_columns: Vec<String>,
        s3_config: S3Config,
    ) -> Self {
        Self {
            bucket_path,
            schema,
            pk_columns,
            s3_config,
        }
    }

    fn build_store(&self) -> Result<Arc<dyn ObjectStore>> {
        let store = AmazonS3Builder::new()
            .with_endpoint(&self.s3_config.endpoint)
            .with_region(&self.s3_config.region)
            .with_bucket_name(&self.s3_config.bucket)
            .with_access_key_id(&self.s3_config.access_key_id)
            .with_secret_access_key(&self.s3_config.secret_access_key)
            .with_allow_http(true)
            .build()
            .map_err(|e| StitchError::Other(e.into()))?;
        Ok(Arc::new(store))
    }

    fn block_on<F, T>(f: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(f)),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(f)
            }
        }
    }

    fn list_vortex_files(&self, file_name: &str) -> Result<Vec<Path>> {
        let prefix = Path::from(self.bucket_path.clone());
        let store = self.build_store()?;

        let mut paths = Self::block_on(async {
            let list = store.list(Some(&prefix));
            use futures::TryStreamExt;
            let objects: Vec<_> = list.try_collect().await?;
            let mut paths = Vec::new();
            for obj in objects {
                let key = obj.location.to_string();
                if key.ends_with(file_name) {
                    paths.push(obj.location);
                }
            }
            Ok::<Vec<Path>, object_store::Error>(paths)
        })
        .map_err(StitchError::ObjectStore)?;

        paths.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));
        Ok(paths)
    }

    fn encode_row_id(bucket_idx: usize, row_id: u64) -> Result<u64> {
        let bucket = u32::try_from(bucket_idx)
            .map_err(|_| StitchError::Other(anyhow::anyhow!("Too many Vortex buckets")))?;
        if row_id > u32::MAX as u64 {
            return Err(StitchError::Other(anyhow::anyhow!(
                "Row id {} exceeds composite encoding limit",
                row_id
            )));
        }
        Ok(((bucket as u64) << 32) | row_id)
    }

    fn decode_row_id(encoded: u64) -> (usize, u64) {
        (((encoded >> 32) as u32) as usize, encoded & 0xffff_ffff)
    }
}

impl FamilyBucketReader for VortexBucketReader {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn is_sorted(&self) -> bool {
        false
    }

    fn has_pk_index(&self) -> bool {
        true
    }

    fn scan_data(&self) -> Result<Vec<RecordBatch>> {
        let store = self.build_store()?;
        let session = make_session();
        let data_files = self.list_vortex_files("data.vortex")?;
        if data_files.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "No Vortex data files found under '{}'",
                self.bucket_path
            )));
        }

        use vortex::file::OpenOptionsSessionExt;

        let batches = Self::block_on(async {
            let mut batches = Vec::new();
            for data_path in &data_files {
                let file = session
                    .open_options()
                    .open_object_store(&store, data_path.as_ref())
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let stream = file
                    .scan()
                    .map_err(|e| StitchError::Other(e.into()))?
                    .into_array_stream()
                    .map_err(|e| StitchError::Other(e.into()))?;

                use vortex::array::stream::ArrayStreamExt;
                let array = stream
                    .read_all()
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let batch = RecordBatch::try_from(&array)
                    .map_err(|e| StitchError::Other(e.into()))?;
                batches.push(batch);
            }

            Ok::<Vec<RecordBatch>, StitchError>(batches)
        })?;

        tracing::debug!(
            path = %self.bucket_path,
            num_batches = batches.len(),
            total_rows = batches.iter().map(|b| b.num_rows()).sum::<usize>(),
            "VortexBucketReader::scan_data"
        );

        Ok(batches)
    }

    fn probe_index(&self, predicate: &PkFilter) -> Result<Vec<(PkValue, u64)>> {
        let store = self.build_store()?;
        let session = make_session();
        let index_files = self.list_vortex_files("pk_index.vortex")?;
        let pk_col = self.pk_columns[0].clone();
        if index_files.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "No Vortex PK index files found under '{}'",
                self.bucket_path
            )));
        }

        use vortex::file::OpenOptionsSessionExt;

        let results = Self::block_on(async {
            let mut results = Vec::new();
            for (bucket_idx, index_path) in index_files.iter().enumerate() {
                let file = session
                    .open_options()
                    .open_object_store(&store, index_path.as_ref())
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let stream = file
                    .scan()
                    .map_err(|e| StitchError::Other(e.into()))?
                    .into_array_stream()
                    .map_err(|e| StitchError::Other(e.into()))?;

                use vortex::array::stream::ArrayStreamExt;
                let array = stream
                    .read_all()
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let batch = RecordBatch::try_from(&array)
                    .map_err(|e| StitchError::Other(e.into()))?;

                let pk_array = batch.column_by_name(&pk_col).ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!("PK column not found in index"))
                })?;
                let row_id_array = batch.column_by_name("row_id").ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!("row_id column not found in index"))
                })?;
                let row_ids = row_id_array
                    .as_any()
                    .downcast_ref::<arrow::array::Int64Array>()
                    .ok_or_else(|| StitchError::Other(anyhow::anyhow!("row_id column is not Int64")))?;

                for i in 0..batch.num_rows() {
                    let pk_value = PkValue::from_array(pk_array.as_ref(), i)?;
                    if !pk_value.matches_filter(predicate) {
                        continue;
                    }
                    let encoded = Self::encode_row_id(bucket_idx, row_ids.value(i) as u64)?;
                    results.push((pk_value, encoded));
                }
            }

            Ok::<Vec<(PkValue, u64)>, StitchError>(results)
        })?;

        Ok(results)
    }

    fn fetch_rows(&self, row_ids: &[u64], _schema: &Schema) -> Result<RecordBatch> {
        let store = self.build_store()?;
        let session = make_session();
        let data_files = self.list_vortex_files("data.vortex")?;
        if data_files.is_empty() {
            return Err(StitchError::Other(anyhow::anyhow!(
                "No Vortex data files found under '{}'",
                self.bucket_path
            )));
        }

        use vortex::buffer::Buffer;
        use vortex::file::OpenOptionsSessionExt;

        let batch = Self::block_on(async {
            let mut grouped: std::collections::BTreeMap<usize, Vec<(usize, u64)>> =
                std::collections::BTreeMap::new();
            for (position, row_id) in row_ids.iter().enumerate() {
                let (bucket_idx, local_row_id) = Self::decode_row_id(*row_id);
                grouped.entry(bucket_idx).or_default().push((position, local_row_id));
            }

            let mut batches = Vec::new();
            let mut concat_to_original = Vec::new();
            for (bucket_idx, bucket_rows) in grouped {
                let data_path = data_files.get(bucket_idx).ok_or_else(|| {
                    StitchError::Other(anyhow::anyhow!(
                        "Vortex bucket index {} out of range for '{}'",
                        bucket_idx,
                        self.bucket_path
                    ))
                })?;
                let local_row_ids: Vec<u64> = bucket_rows.iter().map(|(_, row_id)| *row_id).collect();
                let file = session
                    .open_options()
                    .open_object_store(&store, data_path.as_ref())
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let indices: Buffer<u64> = Buffer::from_iter(local_row_ids.into_iter());
                let stream = file
                    .scan()
                    .map_err(|e| StitchError::Other(e.into()))?
                    .with_row_indices(indices)
                    .into_array_stream()
                    .map_err(|e| StitchError::Other(e.into()))?;

                use vortex::array::stream::ArrayStreamExt;
                let array = stream
                    .read_all()
                    .await
                    .map_err(|e| StitchError::Other(e.into()))?;

                let batch = RecordBatch::try_from(&array)
                    .map_err(|e| StitchError::Other(e.into()))?;
                concat_to_original.extend(bucket_rows.iter().map(|(position, _)| *position));
                batches.push(batch);
            }

            let schema = batches
                .first()
                .map(|batch| batch.schema())
                .ok_or_else(|| StitchError::Other(anyhow::anyhow!("No rows fetched from Vortex")))?;
            let combined = arrow::compute::concat_batches(&schema, &batches)?;
            let mut reorder = vec![None; concat_to_original.len()];
            for (concat_idx, original_idx) in concat_to_original.into_iter().enumerate() {
                reorder[original_idx] = Some(concat_idx as u32);
            }
            let index_array = arrow::array::UInt32Array::from(reorder);
            let reordered_columns = combined
                .columns()
                .iter()
                .map(|column| arrow::compute::take(column.as_ref(), &index_array, None))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(StitchError::Arrow)?;
            let reordered = RecordBatch::try_new(schema, reordered_columns)?;
            Ok::<RecordBatch, StitchError>(reordered)
        })?;

        tracing::debug!(
            path = %self.bucket_path,
            num_rows = batch.num_rows(),
            "VortexBucketReader::fetch_rows (random access)"
        );

        Ok(batch)
    }
}
