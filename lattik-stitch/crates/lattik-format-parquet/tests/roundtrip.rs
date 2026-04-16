use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use object_store::memory::InMemory;

use lattik_stitch_core::format::FamilyBucketReader;
use lattik_stitch_core::stitcher::naive::NaiveStitcher;
use lattik_stitch_core::stitcher::Stitcher;

#[tokio::test(flavor = "multi_thread")]
async fn test_parquet_write_and_read() {
    let store = Arc::new(InMemory::new());

    // Create test data: 3 rows, sorted by user_id
    let schema = Arc::new(Schema::new(vec![
        Field::new("user_id", DataType::Int64, false),
        Field::new("home_country", DataType::Utf8, true),
    ]));

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(vec![100, 200, 300])),
            Arc::new(StringArray::from(vec!["US", "JP", "DE"])),
        ],
    )
    .unwrap();

    // Write
    lattik_format_parquet::write_bucket_with_store(
        &(store.clone() as Arc<dyn object_store::ObjectStore>),
        "test_table/loads/uuid-aaa/bucket=0000",
        &[batch],
        &schema,
    )
    .unwrap();

    // Read back
    let reader = lattik_format_parquet::open_bucket_with_store(
        store.clone() as Arc<dyn object_store::ObjectStore>,
        "test_table/loads/uuid-aaa/bucket=0000",
        &schema,
    );

    assert!(reader.is_sorted());
    assert!(!reader.has_pk_index());

    let batches = reader.scan_data().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].num_rows(), 3);

    let user_ids = batches[0]
        .column_by_name("user_id")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(user_ids.values(), &[100, 200, 300]);

    let countries = batches[0]
        .column_by_name("home_country")
        .unwrap()
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    assert_eq!(countries.value(0), "US");
    assert_eq!(countries.value(1), "JP");
    assert_eq!(countries.value(2), "DE");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_stitch_two_loads() {
    let store = Arc::new(InMemory::new());

    // Load A: signups family (home_country)
    let schema_a = Arc::new(Schema::new(vec![
        Field::new("user_id", DataType::Int64, false),
        Field::new("home_country", DataType::Utf8, true),
    ]));
    let batch_a = RecordBatch::try_new(
        schema_a.clone(),
        vec![
            Arc::new(Int64Array::from(vec![100, 200, 300])),
            Arc::new(StringArray::from(vec!["US", "JP", "DE"])),
        ],
    )
    .unwrap();

    lattik_format_parquet::write_bucket_with_store(
        &(store.clone() as Arc<dyn object_store::ObjectStore>),
        "test_table/loads/load-a/bucket=0000",
        &[batch_a],
        &schema_a,
    )
    .unwrap();

    // Load B: purchases family (lifetime_revenue)
    let schema_b = Arc::new(Schema::new(vec![
        Field::new("user_id", DataType::Int64, false),
        Field::new("lifetime_revenue", DataType::Float64, true),
    ]));
    let batch_b = RecordBatch::try_new(
        schema_b.clone(),
        vec![
            Arc::new(Int64Array::from(vec![100, 300, 400])),
            Arc::new(Float64Array::from(vec![500.0, 80.0, 20.0])),
        ],
    )
    .unwrap();

    lattik_format_parquet::write_bucket_with_store(
        &(store.clone() as Arc<dyn object_store::ObjectStore>),
        "test_table/loads/load-b/bucket=0000",
        &[batch_b],
        &schema_b,
    )
    .unwrap();

    // Read both loads
    let reader_a = lattik_format_parquet::open_bucket_with_store(
        store.clone() as Arc<dyn object_store::ObjectStore>,
        "test_table/loads/load-a/bucket=0000",
        &schema_a,
    );
    let reader_b = lattik_format_parquet::open_bucket_with_store(
        store.clone() as Arc<dyn object_store::ObjectStore>,
        "test_table/loads/load-b/bucket=0000",
        &schema_b,
    );

    // Stitch with NaiveStitcher
    let output_schema = Schema::new(vec![
        Field::new("user_id", DataType::Int64, false),
        Field::new("home_country", DataType::Utf8, true),
        Field::new("lifetime_revenue", DataType::Float64, true),
    ]);

    let mut readers: HashMap<String, Box<dyn FamilyBucketReader>> = HashMap::new();
    readers.insert("load-a".to_string(), reader_a);
    readers.insert("load-b".to_string(), reader_b);

    let mut stitcher = NaiveStitcher::new();
    stitcher
        .init(
            readers,
            vec!["user_id".to_string()],
            output_schema.clone(),
            None,
        )
        .unwrap();

    // Collect all stitched batches
    let mut all_rows = Vec::new();
    while stitcher.has_next() {
        let batch = stitcher.next_batch().unwrap();
        let user_ids = batch
            .column_by_name("user_id")
            .unwrap()
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        let countries = batch
            .column_by_name("home_country")
            .unwrap()
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        let revenues = batch
            .column_by_name("lifetime_revenue")
            .unwrap()
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();

        for i in 0..batch.num_rows() {
            all_rows.push((
                user_ids.value(i),
                if countries.is_null(i) {
                    None
                } else {
                    Some(countries.value(i).to_string())
                },
                if revenues.is_null(i) {
                    None
                } else {
                    Some(revenues.value(i))
                },
            ));
        }
    }

    // Sort by user_id for deterministic assertion
    all_rows.sort_by_key(|(uid, _, _)| *uid);

    // FULL OUTER JOIN expected:
    // user_id=100: US, 500.0
    // user_id=200: JP, NULL    (not in purchases)
    // user_id=300: DE, 80.0
    // user_id=400: NULL, 20.0  (not in signups)
    assert_eq!(all_rows.len(), 4);
    assert_eq!(all_rows[0], (100, Some("US".to_string()), Some(500.0)));
    assert_eq!(all_rows[1], (200, Some("JP".to_string()), None));
    assert_eq!(all_rows[2], (300, Some("DE".to_string()), Some(80.0)));
    assert_eq!(all_rows[3], (400, None, Some(20.0)));
}
