use std::sync::Arc;

use object_store::aws::AmazonS3Builder;
use object_store::ObjectStore;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::types::S3Config;

/// Build an S3-compatible ObjectStore from config.
pub fn build_s3_store(s3_config: &S3Config) -> Result<Arc<dyn ObjectStore>> {
    let store = AmazonS3Builder::new()
        .with_endpoint(&s3_config.endpoint)
        .with_region(&s3_config.region)
        .with_bucket_name(&s3_config.bucket)
        .with_access_key_id(&s3_config.access_key_id)
        .with_secret_access_key(&s3_config.secret_access_key)
        .with_allow_http(true)
        .build()
        .map_err(|e| StitchError::Other(e.into()))?;
    Ok(Arc::new(store))
}
