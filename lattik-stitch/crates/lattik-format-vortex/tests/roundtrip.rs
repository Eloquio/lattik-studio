use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use lattik_stitch_core::format::{FamilyBucketReader, FamilyFormat};
use lattik_stitch_core::types::{PkFilter, PkValue, S3Config};

/// Create a test S3Config for in-memory testing.
/// Note: Vortex's object_store integration requires an actual S3 endpoint.
/// For unit tests, we test the Arrow interop and PK index logic directly.
/// Full S3 integration is tested via the SparkApplication test.

#[test]
fn test_vortex_format_properties() {
    let format = lattik_format_vortex::VortexFormat;
    assert_eq!(format.id(), "vortex");
    assert!(format.supports_random_access());
}

#[test]
fn test_vortex_write_bucket_without_index_fails() {
    let format = lattik_format_vortex::VortexFormat;
    let schema = Schema::new(vec![Field::new("x", DataType::Int64, false)]);
    let s3_config = S3Config {
        endpoint: "http://localhost:9000".to_string(),
        region: "us-east-1".to_string(),
        bucket: "test".to_string(),
        access_key_id: "key".to_string(),
        secret_access_key: "secret".to_string(),
    };

    let result = format.write_bucket("test/bucket=0000", vec![], &schema, &s3_config);
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(err_msg.contains("without index"), "Expected 'without index' error, got: {}", err_msg);
}
