//! Manifest resolution — turns a (table_name, version, s3_config) into a
//! fully-populated session by reading manifests and load metadata from S3.

use std::collections::{HashMap, HashSet};

use futures::StreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path;
use object_store::ObjectStore;

use lattik_stitch_core::error::{Result, StitchError};
use lattik_stitch_core::manifest::{read_load_metadata, read_manifest};
use lattik_stitch_core::types::S3Config;

use crate::session::{LoadSpec, OutputColumn, SessionConfig};

/// High-level config for a table scan. The DuckDB extension builds this
/// from function arguments + DuckDB settings, then resolves it into a
/// full SessionConfig by reading S3.
pub struct TableScanConfig {
    pub table_name: String,
    /// Manifest version. 0 = find the latest.
    pub version: u64,
    /// S3 prefix where all Lattik tables live, e.g. "warehouse/lattik"
    pub warehouse_path: String,
    pub s3_config: S3Config,
}

fn build_store(s3: &S3Config) -> Result<Box<dyn ObjectStore>> {
    let store = AmazonS3Builder::new()
        .with_endpoint(&s3.endpoint)
        .with_region(&s3.region)
        .with_bucket_name(&s3.bucket)
        .with_access_key_id(&s3.access_key_id)
        .with_secret_access_key(&s3.secret_access_key)
        .with_allow_http(true)
        .build()
        .map_err(|e| StitchError::Other(e.into()))?;
    Ok(Box::new(store))
}

/// Find the latest manifest version by listing the manifests/ prefix.
async fn find_latest_manifest(
    store: &dyn ObjectStore,
    table_path: &str,
) -> Result<(u64, String)> {
    let prefix = Path::from(format!("{}/manifests/", table_path));
    let list: Vec<_> = store
        .list(Some(&prefix))
        .collect::<Vec<_>>()
        .await;

    let mut best_version: u64 = 0;
    let mut best_load_id = String::new();

    for item in list.into_iter().flatten() {
        let name = item.location.filename().unwrap_or_default().to_string();
        // Manifest filenames: v0001_<load_id>.json
        if let Some(rest) = name.strip_prefix('v') {
            if let Some((ver_str, load_part)) = rest.split_once('_') {
                if let Ok(ver) = ver_str.parse::<u64>() {
                    if ver > best_version {
                        best_version = ver;
                        best_load_id = load_part.trim_end_matches(".json").to_string();
                    }
                }
            }
        }
    }

    if best_version == 0 {
        return Err(StitchError::ManifestNotFound {
            path: format!("{}/manifests/", table_path),
        });
    }

    Ok((best_version, best_load_id))
}

/// Find the load_id for a specific manifest version.
async fn find_manifest_load_id(
    store: &dyn ObjectStore,
    table_path: &str,
    version: u64,
) -> Result<String> {
    let prefix = Path::from(format!("{}/manifests/", table_path));
    let pattern = format!("v{:04}_", version);
    let list: Vec<_> = store.list(Some(&prefix)).collect::<Vec<_>>().await;

    for item in list.into_iter().flatten() {
        let name = item.location.filename().unwrap_or_default().to_string();
        if name.starts_with(&pattern) {
            return Ok(name
                .trim_start_matches(&pattern)
                .trim_end_matches(".json")
                .to_string());
        }
    }

    Err(StitchError::ManifestNotFound {
        path: format!("{}/manifests/v{:04}_*.json", table_path, version),
    })
}

/// Resolve a `TableScanConfig` into a `SessionConfig` with fully-populated
/// load_specs by reading the manifest and load metadata from S3.
pub async fn resolve_table_scan(config: &TableScanConfig) -> Result<SessionConfig> {
    let store = build_store(&config.s3_config)?;

    let warehouse_prefix = strip_s3_prefix(&config.warehouse_path, &config.s3_config.bucket);
    let table_path = format!("{}/{}", warehouse_prefix, config.table_name);

    // Resolve manifest version
    let (version, load_id) = if config.version == 0 {
        find_latest_manifest(store.as_ref(), &table_path).await?
    } else {
        let lid = find_manifest_load_id(store.as_ref(), &table_path, config.version).await?;
        (config.version, lid)
    };

    // Read the manifest
    let manifest = read_manifest(store.as_ref(), &table_path, version, &load_id).await?;

    // Collect unique load_ids → their columns
    let mut load_columns: HashMap<String, Vec<String>> = HashMap::new();
    for (col_name, col_load_id) in &manifest.columns {
        load_columns
            .entry(col_load_id.clone())
            .or_default()
            .push(col_name.clone());
    }

    // Read load metadata for each unique load
    let mut load_specs = Vec::new();
    let mut output_columns = Vec::new();
    let mut pk_columns: Vec<String> = Vec::new();
    let mut pk_seen: HashSet<String> = HashSet::new();

    for (lid, columns) in &load_columns {
        let meta = read_load_metadata(store.as_ref(), &table_path, lid).await?;

        // Infer PK columns: columns in load.json that aren't in this load's
        // manifest column mapping are PK columns (shared across all loads)
        if pk_columns.is_empty() {
            for col in &meta.columns {
                if !columns.contains(col) && pk_seen.insert(col.clone()) {
                    pk_columns.push(col.clone());
                }
            }
        }

        let bucket_path = format!(
            "{}/{}/loads/{}/bucket=0000/",
            warehouse_prefix, config.table_name, lid
        );

        load_specs.push(LoadSpec {
            load_id: lid.clone(),
            path: bucket_path,
            columns: columns.clone(),
            pk_columns: pk_columns.clone(),
            format_id: meta.format.clone(),
            sorted: meta.sorted,
            has_pk_index: meta.has_pk_index,
        });

        for col in columns {
            output_columns.push(OutputColumn {
                name: col.clone(),
                data_type: "string".to_string(),
            });
        }
    }

    // PK columns first in output
    let mut full_output_columns = Vec::new();
    for pk in &pk_columns {
        full_output_columns.push(OutputColumn {
            name: pk.clone(),
            data_type: "int64".to_string(),
        });
    }
    full_output_columns.extend(output_columns);

    Ok(SessionConfig {
        load_specs,
        pk_columns,
        stitcher_id: "naive".to_string(),
        output_columns: Some(full_output_columns),
        pk_filter: None,
        s3_config: config.s3_config.clone(),
    })
}

/// Strip "s3://<bucket>/" prefix from a path.
fn strip_s3_prefix(path: &str, bucket: &str) -> String {
    let prefixes = [
        format!("s3://{}/", bucket),
        format!("s3a://{}/", bucket),
    ];
    for prefix in &prefixes {
        if let Some(stripped) = path.strip_prefix(prefix.as_str()) {
            return stripped.trim_end_matches('/').to_string();
        }
    }
    path.trim_end_matches('/').to_string()
}
