# Local Data Lake

A local mirror of the production data lake (S3 + Iceberg) running in the kind cluster, with [Trino](https://trino.io) as the query engine. Lets you write, read, and inspect Iceberg tables end-to-end without touching real S3.

## What's in the stack

| Service | Role | Image | Port (in cluster) |
|---|---|---|---|
| **Trino** | Distributed SQL query engine. Single-node coordinator-and-worker for local dev. | `trinodb/trino:468` | `8080` |
| **iceberg-rest** | Iceberg REST catalog. Stores which tables exist and where their metadata lives. SQLite-backed. | `tabulario/iceberg-rest:1.6.0` | `8181` |
| **MinIO** | S3-compatible object storage. Holds the actual parquet data files and Iceberg metadata.json files. | `minio/minio` | `9000` (S3 API), `9001` (web console) |

All four services run in the kind cluster. Their data persistence is handled by `PersistentVolumeClaim`s against kind's default StorageClass — see [Persistence](#persistence) below.

## Architecture

```
┌─────────────┐    SQL     ┌──────────┐    REST    ┌──────────────┐
│  trino:cli  │ ─────────▶ │  Trino   │ ─────────▶ │ iceberg-rest │
│  Trino UI   │            │  :8080   │            │   :8181      │
└─────────────┘            └────┬─────┘            └──────┬───────┘
                                │                         │
                                │       S3 protocol       │
                                ▼                         ▼
                         ┌────────────────────────────────┐
                         │   MinIO  (S3:9000  UI:9001)   │
                         │   bucket: warehouse           │
                         └────────────────────────────────┘
```

- **Trino** asks `iceberg-rest` "where is table `foo`?" and gets back a pointer to the current `metadata.json` in MinIO. It then reads metadata, manifests, and parquet data files directly from MinIO.
- **iceberg-rest** keeps the catalog state (which tables exist, where their current metadata is) in a local SQLite file on the `iceberg-data` PVC. When Trino commits a write, iceberg-rest also writes new metadata files to MinIO via its own S3 client.
- **MinIO** is the only place real bytes live. The `warehouse` bucket is created on first startup by a one-shot `minio-init` job.

The two ports exposed to your laptop are `8080` (Trino UI / API) and `9001` (MinIO web console). Both are mapped via `extraPortMappings` in [`k8s/kind-config.yaml`](../k8s/kind-config.yaml). The S3 API on `9000` is also mapped, so you can run `mc` or `aws s3` commands against `http://localhost:9000` from your laptop if you want.

## Bringing it up

```bash
# Just the data lake stack (assumes the cluster is already up)
pnpm trino:start

# Or as part of the full dev env
pnpm dev:up
```

`trino:start` is a chained `kubectl apply` that brings up MinIO, runs the `minio-init` Job to create the `warehouse` bucket, applies `iceberg-rest`, then applies `trino`. Each step waits for readiness before the next, so a non-zero exit means something broke at a specific stage — check the corresponding pod's logs.

To tear it down without killing the rest of the cluster:

```bash
pnpm trino:stop
```

This deletes the trino, iceberg-rest, and minio Deployments + Services + the PVCs. **Data is lost.** The cluster keeps running so postgres and gitea are unaffected.

## Querying

### From the CLI

```bash
pnpm trino:cli
```

Wraps `kubectl exec -it deploy/trino -- trino`. You get an interactive SQL prompt connected to the in-cluster coordinator. The two catalogs registered out of the box are `tpch` (synthetic data, generated on the fly, no storage) and `iceberg` (the real local data lake).

Smallest possible end-to-end smoke test:

```sql
trino> SELECT count(*) FROM tpch.tiny.nation;        -- proves Trino is up
trino> CREATE SCHEMA iceberg.smoke;                   -- proves the REST catalog responds
trino> CREATE TABLE iceberg.smoke.t (id BIGINT, msg VARCHAR);
trino> INSERT INTO iceberg.smoke.t VALUES (1, 'hello');
trino> SELECT * FROM iceberg.smoke.t;                 -- proves the read path
```

If all five succeed, the whole stack — Trino, iceberg-rest, MinIO, and the PVC backing — is healthy. For more SQL, the [Trino documentation](https://trino.io/docs/current/) covers the query language and connector specifics.

### From the web UI

Open <http://localhost:8080> in a browser. No auth (local dev only). You can see running queries, the query plan visualizer, the worker list, and basic cluster metrics. Useful for watching a slow `tpch.sf10` query progress in real time.

### Inspecting MinIO directly

Open the MinIO console at <http://localhost:9001>. Login: `lattik` / `lattik-local`. You'll see the `warehouse` bucket, with everything you've written under `warehouse/<schema>/<table>/`. The `metadata/` folder holds Iceberg metadata.json + manifest files; the `data/` folder holds the parquet.

Or from the CLI, via the `mc` client baked into the MinIO image:

```bash
kubectl exec deploy/minio -- mc alias set local http://localhost:9000 lattik lattik-local
kubectl exec deploy/minio -- mc ls -r local/warehouse/
```

## Persistence

All four services store their data on `PersistentVolumeClaim`s backed by kind's default StorageClass (`rancher.io/local-path`, which writes to the kind node container's ext4 filesystem):

| PVC | Size | Holds |
|---|---|---|
| `minio-data` | 20 Gi | Parquet data files + Iceberg metadata files |
| `iceberg-data` | 1 Gi | The REST catalog's SQLite db (which tables exist, where they live) |
| `postgres-data` | 5 Gi | App database (NextAuth, conversations, definitions, etc.) |
| `gitea-data` | 5 Gi | Gitea repos and config |

**What survives:**

- Pod restarts (`kubectl delete pod ...`, image upgrades, rolling restarts)
- `pnpm db:start`/`pnpm db:stop` cycles (within a cluster lifetime)
- Host reboots if you don't `dev:down` first (the kind container comes back up with PVs intact)

**What doesn't:**

- `pnpm trino:stop` — the manifest delete also drops the PVCs.
- `pnpm dev:down` / `pnpm cluster:down` — deletes the kind container, and the local-path PVs live inside it.

**If you need cross-recreate persistence**, snapshot manually before tearing down:

```bash
# Postgres
kubectl exec deploy/postgres -- pg_dump -U lattik lattik_studio | gzip > pg-snapshot.sql.gz

# MinIO bucket → laptop
kubectl exec deploy/minio -- mc alias set local http://localhost:9000 lattik lattik-local
kubectl exec deploy/minio -- mc cp -r local/warehouse/ /tmp/warehouse/
kubectl cp default/minio-<podid>:/tmp/warehouse ./warehouse-snapshot
```

This was a deliberate trade-off — host bind mounts on macOS+kind hit a wall with file-sharing-layer chmod restrictions (postgres can't chmod its data dir to `0700`, iceberg-rest's non-root user can't write the catalog sqlite db without an `initContainer` hack). We picked PVCs and accepted cluster-scoped persistence as the cleaner story. The sibling [`projects/testenv`](../../testenv) project does the same.

## Image management

The data lake images are large (Trino alone is ~2 GB) and we've seen Docker Hub TLS handshake timeouts during in-cluster pulls. The kubelet retries with backoff but it can stall `pnpm trino:start` for several minutes before succeeding or giving up.

If you hit `ImagePullBackOff` on any of these:

```bash
# Pull on the host first (uses Docker Desktop's network, more reliable)
docker pull trinodb/trino:468
docker pull tabulario/iceberg-rest:1.6.0
docker pull minio/minio:RELEASE.2025-01-20T14-49-07Z
docker pull minio/mc:RELEASE.2025-01-17T23-25-50Z

# Side-load into the kind node (no registry pull needed)
kind load docker-image trinodb/trino:468 --name lattik
kind load docker-image tabulario/iceberg-rest:1.6.0 --name lattik
kind load docker-image minio/minio:RELEASE.2025-01-20T14-49-07Z --name lattik
kind load docker-image minio/mc:RELEASE.2025-01-17T23-25-50Z --name lattik

# Bounce the failing pods so they retry the (now-cached) image
kubectl delete pod -l app=trino
kubectl delete pod -l app=iceberg-rest
kubectl delete pod -l app=minio
```

A fully cold-cached `pnpm trino:start` takes ~3–4 minutes the first time (image pulls dominate). Subsequent starts after the host has the images cached are ~60–90 seconds (mostly Trino's JVM startup).

## Troubleshooting

**Pod stuck in `ImagePullBackOff`**
Network issue pulling the image. See [Image management](#image-management) above. Look at `kubectl describe pod -l app=<name> | grep Failed` to see the actual pull error — `TLS handshake timeout` means Docker Hub flake, `manifest unknown` means the tag is wrong.

**Pod stuck in `Pending` with "0/1 nodes available"**
Almost always a PVC binding issue. Check `kubectl get pvc` — if any PVC is `Pending`, the StorageClass isn't provisioning. Verify with `kubectl get storageclass` that `standard (default)` exists. If it doesn't, the cluster wasn't created cleanly — `pnpm dev:down && pnpm cluster:up` to recreate.

**`iceberg-rest` crash-loops with `Permission denied` opening `/data/iceberg_rest.db`**
Should not happen with PVCs — this was the old bug from when we used host bind mounts. If it does come back, you're probably on a fork that reverted [`k8s/iceberg-rest.yaml`](../k8s/iceberg-rest.yaml) to use a `hostPath` volume. The fix is to use a PVC instead.

**Trino starts but every query fails with `EXCEEDED_LOCAL_MEMORY_LIMIT`**
The conservative memory limits in [`k8s/trino.yaml`](../k8s/trino.yaml) are sized for laptop comfort, not heavy workloads. Bump `query.max-memory-per-node` in the `trino-config` ConfigMap and the container `resources.limits.memory` if you're running real-data-sized queries.

**`SELECT` works but `INSERT` fails with `Access Denied` to MinIO**
Check that the `s3.aws-access-key`/`s3.aws-secret-key` in [`k8s/trino.yaml`](../k8s/trino.yaml)'s iceberg catalog config match the `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in [`k8s/minio.yaml`](../k8s/minio.yaml)'s secret. They both default to `lattik` / `lattik-local`; if you've changed one, change the other.

**`pnpm trino:cli` hangs forever**
The Trino pod is probably still starting up. JVM cold start takes 30–60s after the container is `Ready`. `kubectl logs -l app=trino` and look for `SERVER STARTED` near the end.

**MinIO console at `localhost:9001` won't connect**
The port mapping only takes effect if the cluster was created with the current [`k8s/kind-config.yaml`](../k8s/kind-config.yaml). If you're on an older cluster, `pnpm dev:down && pnpm dev:up` to recreate. As a workaround without recreating, `kubectl port-forward svc/minio 9001:9001`.

## See also

- [`k8s/trino.yaml`](../k8s/trino.yaml), [`k8s/iceberg-rest.yaml`](../k8s/iceberg-rest.yaml), [`k8s/minio.yaml`](../k8s/minio.yaml) — the manifests
- [`k8s/kind-config.yaml`](../k8s/kind-config.yaml) — port mappings
- [Trino docs](https://trino.io/docs/current/) — query language and connector reference
- [Iceberg REST spec](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml) — what `iceberg-rest` actually implements
