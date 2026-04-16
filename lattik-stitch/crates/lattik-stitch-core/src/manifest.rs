use object_store::{ObjectStore, ObjectStoreExt, PutPayload};
use object_store::path::Path;

use crate::error::{Result, StitchError};
use crate::types::{LoadMetadata, Manifest};

/// Read a manifest from S3.
pub async fn read_manifest(
    store: &dyn ObjectStore,
    table_path: &str,
    version: u64,
    load_id: &str,
) -> Result<Manifest> {
    let path = Path::from(format!(
        "{}/manifests/v{:04}_{}.json",
        table_path, version, load_id
    ));
    let bytes = store.get(&path).await?.bytes().await?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    Ok(manifest)
}

/// Write a manifest to S3. Manifests are immutable — this always creates a new file.
pub async fn write_manifest(
    store: &dyn ObjectStore,
    table_path: &str,
    manifest: &Manifest,
    load_id: &str,
) -> Result<()> {
    let path = Path::from(format!(
        "{}/manifests/v{:04}_{}.json",
        table_path, manifest.version, load_id
    ));
    let bytes = serde_json::to_vec_pretty(manifest)?;
    store.put(&path, bytes.into()).await?;
    Ok(())
}

/// Read a load.json from S3.
pub async fn read_load_metadata(
    store: &dyn ObjectStore,
    table_path: &str,
    load_id: &str,
) -> Result<LoadMetadata> {
    let path = Path::from(format!("{}/loads/{}/load.json", table_path, load_id));
    let bytes = store
        .get(&path)
        .await
        .map_err(|_| StitchError::LoadNotFound {
            load_id: load_id.to_string(),
        })?
        .bytes()
        .await?;
    let meta: LoadMetadata = serde_json::from_slice(&bytes)?;
    Ok(meta)
}

/// Write a load.json to S3.
pub async fn write_load_metadata(
    store: &dyn ObjectStore,
    table_path: &str,
    meta: &LoadMetadata,
) -> Result<()> {
    let path = Path::from(format!(
        "{}/loads/{}/load.json",
        table_path, meta.load_id
    ));
    let bytes = serde_json::to_vec_pretty(meta)?;
    store.put(&path, bytes.into()).await?;
    Ok(())
}

/// Build a new manifest by carrying forward the base manifest's columns
/// and overriding with the new load's columns.
pub fn rebase_manifest(
    base: &Manifest,
    new_version: u64,
    column_overrides: &[(String, String)], // (column_name, load_id)
) -> Manifest {
    let mut columns = base.columns.clone();
    for (col_name, load_id) in column_overrides {
        columns.insert(col_name.clone(), load_id.clone());
    }
    Manifest {
        version: new_version,
        columns,
    }
}
