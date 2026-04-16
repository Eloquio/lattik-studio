use std::sync::Arc;

use arrow::array::{Array, Int64Array, RecordBatch};
use arrow::datatypes::{DataType, Field, Schema};
use object_store::aws::AmazonS3Builder;
use object_store::ObjectStore;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::types::S3Config;

use crate::session::make_session;

/// Write data + PK index sidecar as Vortex files to S3.
pub fn write_vortex_bucket_with_index(
    bucket_path: &str,
    batches: &[RecordBatch],
    _schema: &Schema,
    pk_columns: &[String],
    s3_config: &S3Config,
) -> Result<()> {
    if batches.is_empty() {
        tracing::debug!(path = %bucket_path, "write_vortex_bucket: no data, skipping");
        return Ok(());
    }

    let store: Arc<dyn ObjectStore> = Arc::new(
        AmazonS3Builder::new()
            .with_endpoint(&s3_config.endpoint)
            .with_region(&s3_config.region)
            .with_bucket_name(&s3_config.bucket)
            .with_access_key_id(&s3_config.access_key_id)
            .with_secret_access_key(&s3_config.secret_access_key)
            .with_allow_http(true)
            .build()
            .map_err(|e| StitchError::Other(e.into()))?,
    );

    let block_on = |f: std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>>>>| -> Result<()> {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(f)),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(f)
            }
        }
    };

    // 1. Write data.vortex
    let data_path = format!("{}/data.vortex", bucket_path);
    let data_batches = batches.to_vec();
    let store_clone = store.clone();

    block_on(Box::pin(async move {
        use vortex::array::arrow::FromArrowArray;
        use vortex::array::stream::ArrayStreamExt;
        use vortex::array::ArrayRef;
        use vortex::file::WriteOptionsSessionExt;
        use vortex::io::object_store::ObjectStoreWrite;

        let session = make_session();
        let mut writer = ObjectStoreWrite::new(
            store_clone,
            &object_store::path::Path::from(data_path),
        ).await.map_err(|e| StitchError::Other(e.into()))?;

        for batch in &data_batches {
            let vx_array = ArrayRef::from_arrow(batch, false)
                .map_err(|e| StitchError::Other(e.into()))?;
            session
                .write_options()
                .write(&mut writer, vx_array.to_array_stream())
                .await
                .map_err(|e| StitchError::Other(e.into()))?;
        }

        Ok(())
    }))?;

    // 2. Build PK index and write pk_index.vortex
    let pk_col_name = &pk_columns[0];

    let mut pk_row_pairs: Vec<(i64, i64)> = Vec::new();
    let mut row_offset: i64 = 0;
    for batch in batches {
        let pk_array = batch
            .column_by_name(pk_col_name)
            .ok_or_else(|| StitchError::Other(anyhow::anyhow!("PK column '{}' not found", pk_col_name)))?;
        let pk_int = pk_array
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or_else(|| StitchError::Other(anyhow::anyhow!("PK column must be Int64")))?;

        for i in 0..batch.num_rows() {
            pk_row_pairs.push((pk_int.value(i), row_offset + i as i64));
        }
        row_offset += batch.num_rows() as i64;
    }

    // Sort by PK for zone-map efficiency
    pk_row_pairs.sort_by_key(|(pk, _)| *pk);

    let pks: Vec<i64> = pk_row_pairs.iter().map(|(pk, _)| *pk).collect();
    let row_ids: Vec<i64> = pk_row_pairs.iter().map(|(_, rid)| *rid).collect();

    let index_schema = Arc::new(Schema::new(vec![
        Field::new(pk_col_name, DataType::Int64, false),
        Field::new("row_id", DataType::Int64, false),
    ]));
    let index_batch = RecordBatch::try_new(
        index_schema,
        vec![
            Arc::new(Int64Array::from(pks)),
            Arc::new(Int64Array::from(row_ids)),
        ],
    ).map_err(|e| StitchError::Other(e.into()))?;

    let index_path = format!("{}/pk_index.vortex", bucket_path);
    let store_clone2 = store.clone();

    block_on(Box::pin(async move {
        use vortex::array::arrow::FromArrowArray;
        use vortex::array::stream::ArrayStreamExt;
        use vortex::array::ArrayRef;
        use vortex::file::WriteOptionsSessionExt;
        use vortex::io::object_store::ObjectStoreWrite;

        let session = make_session();
        let mut writer = ObjectStoreWrite::new(
            store_clone2,
            &object_store::path::Path::from(index_path),
        ).await.map_err(|e| StitchError::Other(e.into()))?;

        let vx_index = ArrayRef::from_arrow(&index_batch, false)
            .map_err(|e| StitchError::Other(e.into()))?;

        session
            .write_options()
            .write(&mut writer, vx_index.to_array_stream())
            .await
            .map_err(|e| StitchError::Other(e.into()))?;

        Ok(())
    }))?;

    tracing::debug!(
        path = %bucket_path,
        num_batches = batches.len(),
        total_rows = batches.iter().map(|b| b.num_rows()).sum::<usize>(),
        index_rows = pk_row_pairs.len(),
        "write_vortex_bucket_with_index"
    );

    Ok(())
}
