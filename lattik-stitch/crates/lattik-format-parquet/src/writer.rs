use std::sync::Arc;

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;
use object_store::path::Path;
use object_store::{ObjectStore, ObjectStoreExt};
use parquet::arrow::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::WriterProperties;

use lattik_stitch_core::error::{Result, StitchError};

/// Write sorted RecordBatches as a Parquet file to S3.
///
/// The caller guarantees batches are sorted by PK. The writer compresses
/// with ZSTD and writes to `<bucket_path>/data.parquet`.
pub fn write_parquet_bucket(
    store: &Arc<dyn ObjectStore>,
    bucket_path: &str,
    batches: &[RecordBatch],
    schema: &Schema,
) -> Result<()> {
    if batches.is_empty() {
        tracing::debug!(path = %bucket_path, "write_parquet_bucket: no data, skipping");
        return Ok(());
    }

    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3).unwrap()))
        .set_max_row_group_size(8192)
        .build();

    let mut buf: Vec<u8> = Vec::new();
    let mut writer = ArrowWriter::try_new(&mut buf, Arc::new(schema.clone()), Some(props))
        .map_err(|e| StitchError::Other(e.into()))?;

    for batch in batches {
        writer
            .write(batch)
            .map_err(|e| StitchError::Other(e.into()))?;
    }

    writer
        .close()
        .map_err(|e| StitchError::Other(e.into()))?;

    let data_path = Path::from(format!("{}/data.parquet", bucket_path));
    let store = store.clone();
    let payload: bytes::Bytes = buf.into();

    // Use block_in_place to allow blocking within a tokio multi-thread runtime,
    // or create a new runtime if called outside one.
    let put_result = match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(store.put(&data_path, payload.into()))),
        Err(_) => {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(store.put(&data_path, payload.into()))
        }
    };
    put_result.map_err(StitchError::ObjectStore)?;

    tracing::debug!(
        path = %bucket_path,
        num_batches = batches.len(),
        total_rows = batches.iter().map(|b| b.num_rows()).sum::<usize>(),
        "write_parquet_bucket"
    );

    Ok(())
}
