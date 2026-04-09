# Local Data Lake

A local mirror of the production data lake (S3 + Iceberg) running in the kind cluster, with [Trino](https://trino.io) and [Apache Spark](https://spark.apache.org) as the two query/compute engines on top. Lets you write, read, and inspect Iceberg tables end-to-end — and round-trip data between Spark and Trino — without touching real S3.

## What's in the stack

| Service | Role | Image | Namespace | Port (in cluster) |
|---|---|---|---|---|
| **Trino** | Distributed SQL query engine. Single-node coordinator-and-worker for local dev. | `trinodb/trino:480` | `trino` | `8080` |
| **iceberg-rest** | Iceberg REST catalog. Stores which tables exist and where their metadata lives. SQLite-backed. | `tabulario/iceberg-rest:1.6.0` | `iceberg` | `8181` |
| **MinIO** | S3-compatible object storage. Holds the actual parquet data files and Iceberg metadata.json files. | `minio/minio` | `minio` | `9000` (S3 API), `9001` (web console) |
| **Spark Operator** | [kubeflow/spark-operator](https://github.com/kubeflow/spark-operator). Watches the `workloads` namespace for `SparkApplication` CRDs and spawns driver+executor pods. | (helm-managed) | `spark-operator` | — |
| **Spark drivers / executors** | Per-job pods spawned by `SparkApplication` CRDs. Custom image with Iceberg + AWS bundle baked in. | `lattik/spark-iceberg:4.0.2-1.10.1` (built locally) | `workloads` | — |

All services run in the kind cluster. Their data persistence is handled by `PersistentVolumeClaim`s against kind's default StorageClass — see [Persistence](#persistence) below.

## Namespaces

Each service lives in its own namespace so PVCs, secrets, and pods stay isolated. The trade-off compared to a single-namespace setup is more typing (`kubectl -n <ns> ...`) and the need for FQDN cross-namespace DNS — handled in the manifests already.

| Namespace | Owner |
|---|---|
| `postgres` | postgres deployment + PVC + secret + service |
| `gitea` | gitea deployment + PVC + secret + service + init Job |
| `minio` | MinIO deployment + PVC + secret + service + bucket-init Job |
| `iceberg` | iceberg-rest deployment + PVC + service + local copy of MinIO credentials |
| `trino` | Trino coordinator+worker deployment + configmaps + service |
| `spark-operator` | Spark Operator pod (helm-managed) |
| `kafka` | Kafka KRaft broker + PVC + service |
| `schema-registry` | Confluent Schema Registry deployment + service `sr` (stateless — data in Kafka) |
| `workloads` | `SparkApplication`s + driver/executor pods + `spark-driver` ServiceAccount + local copy of MinIO credentials |
| `airflow` | Airflow control plane + worker pods (see [`local-airflow.md`](local-airflow.md)) |

[`k8s/namespaces.yaml`](../k8s/namespaces.yaml) declares all of these and is applied by `pnpm cluster:up` before any other manifest, so per-service scripts can assume their namespace exists.

**Cross-namespace DNS:** services reference each other by `<service>.<namespace>.svc.cluster.local` (or just `<service>.<namespace>` — the `.svc.cluster.local` suffix is added by the cluster's search path). Example: Trino's iceberg catalog talks to iceberg-rest at `http://iceberg-rest.iceberg:8181`, and the iceberg connector's S3 endpoint is `http://minio.minio:9000`. SparkApplications use the FQDN form (`http://iceberg-rest.iceberg.svc.cluster.local:8181`) explicitly because the spark Pod's DNS search path may not include other namespaces by default.

**Cross-namespace secrets:** Kubernetes Secrets are namespace-scoped, so any service that needs to authenticate to MinIO from a different namespace gets its own local copy of the credentials. Currently iceberg-rest and Spark drivers each have a `minio-credentials` Secret in their namespace. Keep the values in lockstep with [`k8s/minio.yaml`](../k8s/minio.yaml).

## Architecture

```
┌─────────────┐                     ┌─────────────────┐
│  trino:cli  │                     │ SparkApplication│
│  Trino UI   │                     │  (CRD + driver) │
└──────┬──────┘                     └────────┬────────┘
       │ SQL                                 │ DataFrame /
       ▼                                     │ spark.sql()
┌──────────────┐   REST    ┌──────────────┐  │
│    Trino     │ ────────▶ │ iceberg-rest │ ◀┤
│   :8080      │           │   :8181      │  │
└──────┬───────┘           └──────┬───────┘  │
       │                          │          │
       │    S3 protocol           │          │
       ▼                          ▼          ▼
┌─────────────────────────────────────────────────┐
│           MinIO  (S3:9000  UI:9001)            │
│           bucket: warehouse                    │
└─────────────────────────────────────────────────┘
```

- **Trino** asks `iceberg-rest` "where is table `foo`?" and gets back a pointer to the current `metadata.json` in MinIO. It then reads metadata, manifests, and parquet data files directly from MinIO.
- **Spark** (running as a `SparkApplication` driver pod managed by the operator) does the same lookup against `iceberg-rest`, reads/writes parquet directly to MinIO, and commits new table snapshots through the catalog. **Both engines see the same tables** because they share the catalog and the warehouse.
- **iceberg-rest** keeps the catalog state (which tables exist, where their current metadata is) in a local SQLite file on the `iceberg-data` PVC. When Trino or Spark commits a write, iceberg-rest also writes new metadata files to MinIO via its own S3 client.
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
kubectl -n minio exec deploy/minio -- mc alias set local http://localhost:9000 lattik lattik-local
kubectl -n minio exec deploy/minio -- mc ls -r local/warehouse/
```

## Spark for compute

Spark is the second engine in the data lake. It reads and writes the same Iceberg tables Trino does — same `iceberg-rest` catalog, same `warehouse` bucket — so anything you write from one is immediately visible to the other. The difference is workload shape: Trino is for interactive SQL exploration, Spark is for batch jobs (transformations, rollups, ML feature builds).

### How it's wired

[Kubeflow's Spark Operator](https://github.com/kubeflow/spark-operator) is helm-installed in the `spark-operator` namespace and configured (via [`k8s/spark/operator-values.yaml`](../k8s/spark/operator-values.yaml)) to watch the `workloads` namespace for `SparkApplication` CRDs. When you submit a `SparkApplication`, the operator creates a driver pod, the driver pod creates executor pods, the job runs to completion, and the operator marks the CRD `COMPLETED`.

### The custom image

The official `apache/spark:4.0.2` image doesn't include the Iceberg runtime or the AWS SDK, so it can't talk to either the REST catalog or MinIO out of the box. We bake the missing pieces in via [`k8s/spark/Dockerfile`](../k8s/spark/Dockerfile):

- **`iceberg-spark-runtime-4.0_2.13:1.10.1`** — the Iceberg connector + Iceberg core for Spark 4.0.x. This is what makes `CREATE TABLE ... USING iceberg` and `df.writeTo("iceberg.db.t")` work.
- **`iceberg-aws-bundle:1.10.1`** — Iceberg's S3FileIO + a bundled AWS SDK v2. This is what writes parquet files to MinIO via the S3 protocol. (We don't need `hadoop-aws` because we're not using `s3a://` paths — the iceberg-aws-bundle is self-contained.)

The image is built locally and side-loaded into the kind node — never pushed to a registry. To rebuild after editing the Dockerfile or bumping the Iceberg version:

```bash
pnpm spark:image-build
```

### Submitting a job

```bash
# Helm-install the operator (one time per cluster lifetime)
pnpm spark:start

# Submit the example SparkApplication
pnpm spark:submit-example
```

[`k8s/spark-example.yaml`](../k8s/spark-example.yaml) is a self-contained example: a `ConfigMap` holding a small PySpark script (creates `iceberg.spark_demo.events`, inserts three rows, reads them back) plus a `SparkApplication` that mounts the script and runs it. After it completes, you can verify cross-engine visibility from Trino:

```bash
pnpm trino:cli
trino> SELECT * FROM iceberg.spark_demo.events;
```

If you see the rows Spark wrote, the entire cross-engine round-trip is healthy: Spark wrote parquet to MinIO via iceberg-aws-bundle, registered a snapshot via iceberg-rest, and Trino read the same snapshot back through the same catalog.

To submit your own job, write a new `SparkApplication` manifest (the example is the canonical reference) and `kubectl apply -n workloads -f your-job.yaml`. Watch progress with:

```bash
kubectl -n workloads get sparkapplications --watch
kubectl -n workloads logs <driver-pod-name>
```

### Required SparkConf for Iceberg

Every SparkApplication that wants to talk to the iceberg-rest catalog needs the same set of `spark.sql.catalog.iceberg.*` properties. The canonical set lives in [`k8s/spark-example.yaml`](../k8s/spark-example.yaml) — copy them verbatim into your own jobs:

```yaml
spark.sql.extensions: "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions"
spark.sql.catalog.iceberg: "org.apache.iceberg.spark.SparkCatalog"
spark.sql.catalog.iceberg.catalog-impl: "org.apache.iceberg.rest.RESTCatalog"
spark.sql.catalog.iceberg.uri: "http://iceberg-rest.iceberg.svc.cluster.local:8181"
spark.sql.catalog.iceberg.warehouse: "s3://warehouse/"
spark.sql.catalog.iceberg.io-impl: "org.apache.iceberg.aws.s3.S3FileIO"
spark.sql.catalog.iceberg.s3.endpoint: "http://minio.minio.svc.cluster.local:9000"
spark.sql.catalog.iceberg.s3.path-style-access: "true"
spark.sql.catalog.iceberg.s3.access-key-id: "lattik"
spark.sql.catalog.iceberg.s3.secret-access-key: "lattik-local"
spark.sql.defaultCatalog: "iceberg"
```

And in the driver/executor pod env (NOT just sparkConf — see the AWS_REGION troubleshooting note below):

```yaml
env:
  - name: AWS_REGION
    value: us-east-1
```

## Persistence

All four services store their data on `PersistentVolumeClaim`s backed by kind's default StorageClass (`rancher.io/local-path`, which writes to the kind node container's ext4 filesystem):

| PVC | Size | Holds |
|---|---|---|
| `minio-data` | 20 Gi | Parquet data files + Iceberg metadata files |
| `iceberg-data` | 1 Gi | The REST catalog's SQLite db (which tables exist, where they live) |
| `postgres-data` | 5 Gi | App database (NextAuth, conversations, definitions, etc.) |
| `gitea-data` | 5 Gi | Gitea repos and config |
| `kafka-data` | 5 Gi | Kafka commit log and topic data |

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

The data lake images are large (Trino is ~2 GB, Spark is ~700 MB on top of Iceberg jars) and we've seen Docker Hub TLS handshake timeouts during in-cluster pulls. The kubelet retries with backoff but it can stall `pnpm trino:start` for several minutes before succeeding or giving up.

If you hit `ImagePullBackOff` on any of these:

```bash
# Pull on the host first (uses Docker Desktop's network, more reliable)
docker pull trinodb/trino:480
docker pull tabulario/iceberg-rest:1.6.0
docker pull minio/minio:RELEASE.2025-01-20T14-49-07Z
docker pull minio/mc:RELEASE.2025-01-17T23-25-50Z

# Side-load into the kind node (no registry pull needed)
kind load docker-image trinodb/trino:480 --name lattik
kind load docker-image tabulario/iceberg-rest:1.6.0 --name lattik
kind load docker-image minio/minio:RELEASE.2025-01-20T14-49-07Z --name lattik
kind load docker-image minio/mc:RELEASE.2025-01-17T23-25-50Z --name lattik

# Bounce the failing pods so they retry the (now-cached) image
kubectl -n trino delete pod -l app=trino
kubectl -n iceberg delete pod -l app=iceberg-rest
kubectl -n minio delete pod -l app=minio
```

A fully cold-cached `pnpm trino:start` takes ~3–4 minutes the first time (image pulls dominate). Subsequent starts after the host has the images cached are ~60–90 seconds (mostly Trino's JVM startup).

The custom Spark image is built locally rather than pulled — `pnpm spark:image-build` runs `docker build` against [`k8s/spark/Dockerfile`](../k8s/spark/Dockerfile), then `kind load`s the result. The first build is dominated by the `apache/spark:4.0.2` base layer pull (~700 MB) and the two Iceberg jar downloads from Maven Central (~80 MB). Subsequent rebuilds after editing the Dockerfile are seconds. The Spark Operator's own image is pulled by helm during `pnpm spark:start` from Docker Hub — small (~100 MB) and rarely flakes.

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
The port mapping only takes effect if the cluster was created with the current [`k8s/kind-config.yaml`](../k8s/kind-config.yaml). If you're on an older cluster, `pnpm dev:down && pnpm dev:up` to recreate. As a workaround without recreating, `kubectl -n minio port-forward svc/minio 9001:9001`.

**Spark job fails with `Unable to load region from any of the providers in the chain`**
The AWS SDK v2 (which `iceberg-aws-bundle` ships) requires a region even when talking to a non-AWS S3 endpoint. The catalog client picks up `spark.sql.catalog.iceberg.s3.region` from sparkConf, but the parquet writer code path on executors uses the SDK's default credentials/region chain, which doesn't see sparkConf. Fix: set `AWS_REGION` as an env var on **both** the driver and executor pods (not just in sparkConf). [`k8s/spark-example.yaml`](../k8s/spark-example.yaml) shows the canonical pattern.

**Spark job's data writes succeed but the SparkApplication is marked `FAILED` with `cannot deletecollection resource`**
The driver's shutdown hook tries to clean up its dynamic PVCs/configmaps via `deletecollection`, which is a separate RBAC verb from `delete`. [`k8s/spark-rbac.yaml`](../k8s/spark-rbac.yaml) grants both. If you've forked the RBAC to be more restrictive, make sure `deletecollection` is included on `pods`, `services`, `configmaps`, and `persistentvolumeclaims`.

**`pnpm spark:start` fails with `helm: command not found`**
Install Helm: `brew install helm` on macOS, or see <https://helm.sh/docs/intro/install/>.

**SparkApplication stuck in `SUBMITTED` or `PENDING` forever, no driver pod appears**
The Spark Operator probably isn't watching the right namespace. Check `helm get values spark-operator -n spark-operator` — it should show `spark.jobNamespaces: [workloads]`. If it doesn't, `pnpm spark:stop && pnpm spark:start` to re-install with the correct values from [`k8s/spark/operator-values.yaml`](../k8s/spark/operator-values.yaml).

**Driver pod starts but immediately fails with `Forbidden: pods is forbidden`**
The driver pod is using the default ServiceAccount in `workloads` (which has no RBAC) instead of `spark-driver`. Make sure your `SparkApplication` spec sets `driver.serviceAccount: spark-driver`. The example does — copy it.

## See also

- [`k8s/namespaces.yaml`](../k8s/namespaces.yaml) — all namespaces
- [`k8s/trino.yaml`](../k8s/trino.yaml), [`k8s/iceberg-rest.yaml`](../k8s/iceberg-rest.yaml), [`k8s/minio.yaml`](../k8s/minio.yaml) — the storage and SQL stack
- [`k8s/spark/Dockerfile`](../k8s/spark/Dockerfile), [`k8s/spark/operator-values.yaml`](../k8s/spark/operator-values.yaml), [`k8s/spark-rbac.yaml`](../k8s/spark-rbac.yaml), [`k8s/spark-example.yaml`](../k8s/spark-example.yaml) — the Spark stack
- [`k8s/kafka.yaml`](../k8s/kafka.yaml) — Kafka KRaft broker
- [`k8s/schema-registry.yaml`](../k8s/schema-registry.yaml) — Confluent Schema Registry
- [`k8s/kind-config.yaml`](../k8s/kind-config.yaml) — port mappings
- [Trino docs](https://trino.io/docs/current/) — query language and connector reference
- [Iceberg REST spec](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml) — what `iceberg-rest` actually implements
- [Iceberg Spark configuration](https://iceberg.apache.org/docs/latest/spark-configuration/) — exhaustive list of `spark.sql.catalog.*` knobs
- [Spark Operator docs](https://www.kubeflow.org/docs/components/spark-operator/) — `SparkApplication` CRD reference
- [`projects/testenv`](../../testenv) — sibling project that uses the same Spark Operator pattern (without Iceberg)
