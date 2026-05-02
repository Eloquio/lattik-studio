//! Iceberg REST catalog integration.
//!
//! Phase 1 scope:
//!   - Configure the REST catalog client with S3 storage (MinIO in dev) for
//!     FileIO via `iceberg-storage-opendal`.
//!   - Load the table by `<schema>.<table>` namespace + name.
//!   - Walk recent snapshots to resolve per-partition HWM via
//!     `Snapshot::summary().additional_properties`.
//!
//! Phase 2 (deferred): build Arrow RecordBatch from buffered rows, write a
//! Parquet file via iceberg-rust's writer chain, append it with
//! `set_snapshot_properties(hwm)` so the next startup picks up where we
//! left off.

use crate::config::Config;
use crate::hwm;
use anyhow::{Context, Result};
use iceberg::io::{
    S3_ACCESS_KEY_ID, S3_ENDPOINT, S3_PATH_STYLE_ACCESS, S3_REGION, S3_SECRET_ACCESS_KEY,
};
use iceberg::table::Table;
use iceberg::{Catalog, CatalogBuilder, NamespaceIdent, TableIdent};
use iceberg_catalog_rest::{
    REST_CATALOG_PROP_URI, REST_CATALOG_PROP_WAREHOUSE, RestCatalog, RestCatalogBuilder,
};
use iceberg_storage_opendal::OpenDalStorageFactory;
use std::collections::HashMap;
use std::sync::Arc;

/// Build a REST catalog client wired to S3 (MinIO in dev) for FileIO.
pub async fn build_catalog(cfg: &Config) -> Result<RestCatalog> {
    let storage_factory = Arc::new(OpenDalStorageFactory::S3 {
        configured_scheme: "s3".to_string(),
        customized_credential_load: None,
    });

    let mut props: HashMap<String, String> = HashMap::new();
    props.insert(REST_CATALOG_PROP_URI.into(), cfg.iceberg_rest_url.clone());
    props.insert(REST_CATALOG_PROP_WAREHOUSE.into(), cfg.warehouse.clone());
    props.insert(S3_ENDPOINT.into(), cfg.s3_endpoint.clone());
    props.insert(S3_ACCESS_KEY_ID.into(), cfg.s3_access_key_id.clone());
    props.insert(
        S3_SECRET_ACCESS_KEY.into(),
        cfg.s3_secret_access_key.clone(),
    );
    // MinIO uses path-style addressing, not virtual-hosted-style.
    props.insert(S3_PATH_STYLE_ACCESS.into(), "true".into());
    // Region is required by the AWS SDK even when MinIO ignores it.
    props.insert(S3_REGION.into(), "us-east-1".into());

    RestCatalogBuilder::default()
        .with_storage_factory(storage_factory)
        .load("rest", props)
        .await
        .context("RestCatalogBuilder::load")
}

/// Load the table identified by `<schema>.<table>`.
pub async fn load_table(catalog: &RestCatalog, cfg: &Config) -> Result<Table> {
    let namespace =
        NamespaceIdent::from_strs([cfg.schema.as_str()]).context("namespace ident")?;
    let ident = TableIdent::new(namespace, cfg.table.clone());
    catalog
        .load_table(&ident)
        .await
        .with_context(|| format!("load_table {}.{}", cfg.schema, cfg.table))
}

/// Walk the table's snapshots (newest first) and resolve max-per-partition
/// HWM from any `kafka_offset_p<n>` keys on snapshot summaries. Returns an
/// empty map for fresh tables — the caller then falls back to
/// `auto.offset.reset=earliest` for those partitions.
pub fn resolve_hwm(table: &Table) -> HashMap<i32, i64> {
    let metadata = table.metadata();
    // Sort snapshots newest-first by their own timestamps so HWM resolution
    // is deterministic regardless of catalog implementation order.
    let mut indexed: Vec<(i64, &HashMap<String, String>)> = metadata
        .snapshots()
        .map(|s| (s.timestamp_ms(), &s.summary().additional_properties))
        .collect();
    indexed.sort_by(|a, b| b.0.cmp(&a.0));
    let summaries = indexed.iter().map(|(_, s)| *s);
    hwm::resolve_from_snapshots(summaries)
}
