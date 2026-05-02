# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Root Cause Analysis Agent). Extension authors define agent logic and what renders on the canvas (charts, tables, etc.).

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 with AI Gateway. Claude Sonnet 4.6 powers the chat agents (data-architect, data-analyst, pipeline-manager); Claude Haiku 4.5 powers the canvas spec stream
- **Auth:** NextAuth v5 (Auth.js beta) — Credentials provider (admin/admin) in dev, Google OAuth in production
- **Database:** PostgreSQL (local via kind) + Drizzle ORM
- **Local data lake:** Trino + Iceberg REST catalog + MinIO, all in kind ([`docs/infra/local-data-lake.md`](docs/infra/local-data-lake.md))
- **Local compute:** Spark 4.0.2 + Iceberg 1.10.1, run as `SparkApplication`s under kubeflow's Spark Operator. Two Spark images: `lattik/spark-stitch` (self-contained, built by [`lattik-stitch`](lattik-stitch/), used by Airflow-triggered materialization jobs) and `lattik/spark-iceberg:4.0.2-1.10.1` (built from [`k8s/spark/Dockerfile`](k8s/spark/Dockerfile), used by manual test fixtures only). Driver scripts are mounted at runtime via a `spark-drivers` ConfigMap, not baked into the image.
- **Orchestration (local dev):** Airflow 3.2.0 with KubernetesExecutor in the same kind cluster, sharing the postgres metadata DB ([`docs/infra/local-airflow.md`](docs/infra/local-airflow.md))
- **Messaging (local dev):** Apache Kafka 3.9.0 in KRaft mode (no ZooKeeper), single-node broker in the kind cluster
- **Schema Registry (local dev):** Confluent Schema Registry 7.7.0 for Protobuf payload schemas, backed by Kafka
- **Ingestion (local dev):** `lattik/ingest` — Go HTTP service that accepts Protobuf envelopes and produces to per-table Kafka topics
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** portless (`https://lattik-studio.dev` via `--tld dev`)
- **Canvas rendering:** `@json-render/core` + `@json-render/react` ([vercel-labs/json-render](https://github.com/vercel-labs/json-render))
- **Expression engine:** `@eloquio/lattik-expression` (parse, type-check, emit SQL)
- **Logger SDK:** `@eloquio/lattik-logger` (Protobuf envelope + typed clients for Logger Tables, auto-generated `.proto` per table via `buf`)
- **Git (local dev):** Gitea in kind cluster for PR review workflow

## Project structure

```
apps/ingest/           Go ingestion service (Protobuf envelope → Kafka)
apps/web/              Next.js app
  src/app/             Pages and API routes
  src/auth/            NextAuth config (Google provider, Drizzle adapter)
  src/components/      UI components (chat, canvas, layout, ui)
  src/db/              Drizzle schema and connection
  src/extensions/      Extension framework and agents
    agents/            Shared agent definitions (e.g. handback)
    registry.ts        Extension registry — registers data-architect, data-analyst, pipeline-manager
    data-architect/    Data Architect extension — defines entities/dimensions/logger+lattik tables/metrics (see README.md inside)
      canvas/          Canvas components + json-render system
      skills/          Skill markdown docs (entity, dimension, logger table, lattik table, metric, reviewing-definitions)
      tools/           Agent tools (getSkill, readCanvasState, reviewDefinition, staticCheck, updateDefinition, submitPR, etc.)
      validation/      Naming, referential, and expression validation
    data-analyst/      Data Analyst extension — explores data via SQL + charts (see README.md inside)
      canvas/          Chart + SQL editor canvas components
      skills/          Skill markdown docs (exploring-data)
      tools/           Agent tools (listTables, describeTable, runQuery, renderChart, renderSqlEditor, updateLayout)
    pipeline-manager/  Pipeline Manager extension — monitors and troubleshoots Airflow DAGs (see README.md inside)
      canvas/          DAG overview + run detail canvas components
      skills/          Skill markdown docs (monitoring-dags, triggering-runs, troubleshooting-failures)
      tools/           Agent tools (listDags, getDagDetail, listDagRuns, getTaskInstances, getTaskLogs, renderDagOverview, renderDagRunDetail)
  src/hooks/           React hooks
  src/lib/             Server actions and utilities
  src/proxy.ts         Auth middleware (protects all routes except /sign-in, /api/auth, /api/webhooks)
docs/                  Architecture and operational docs — see docs/README.md for the full index
k8s/                   Kubernetes manifests
  namespaces.yaml      All namespaces (postgres, gitea, minio, iceberg, trino, spark-operator, kafka, schema-registry, workloads)
  postgres.yaml        Postgres in `postgres` ns
  gitea.yaml           Gitea in `gitea` ns
  minio.yaml           MinIO + bucket-init Job in `minio` ns
  iceberg-rest.yaml    Iceberg REST catalog (sqlite-backed) in `iceberg` ns
  trino.yaml           Trino coordinator+worker in `trino` ns
  airflow.yaml         Airflow 3.x in `airflow` ns (RBAC + init Job + 3 Deployments + NodePort)
  kafka.yaml           Kafka 3.9 KRaft broker in `kafka` ns (PVC + Deployment + NodePort)
  schema-registry.yaml Confluent Schema Registry in `schema-registry` ns (stateless, Deployment + NodePort)
  ingest.yaml          Lattik Ingest service in `workloads` ns (Deployment + NodePort)
  spark/Dockerfile     Custom Spark image (apache/spark:4.0.2 + iceberg jars)
  spark/operator-values.yaml  Helm values for the kubeflow Spark Operator
  spark-rbac.yaml      `spark-driver` SA + Role + RoleBinding in `workloads` ns
  spark-example.yaml   Example SparkApplication that round-trips through iceberg
airflow/dags/          Local Airflow DAGs (hostPath-mounted into the airflow pods — edit live, no restart)
lattik-stitch/         Rust/JVM stitcher (Spark + Trino plugins, JNI bridge)
packages/              Shared packages
  lattik-airflow/      Airflow DAG renderer — reads YAML from S3, builds DAGs (LattikDagRenderer)
  lattik-expression/   Expression engine — parse, type-check, emit SQL
  lattik-logger/       Logger Client SDK — Protobuf envelope, typed clients, proto codegen
```

## Development

```bash
# Start portless proxy with .dev TLD (required for Google OAuth)
portless proxy start --tld dev

# First-time setup (or after `pnpm dev:down`): bootstrap, then start.
# `dev:up` does NOT run bootstrap — run it explicitly first.
pnpm dev:bootstrap   # Preflight + .env + cluster + Postgres + schema + seed + worker creds
pnpm dev:up          # Background services (`dev:services`) + dev server (`dev:web`)

# Day-to-day, when the cluster is already bootstrapped:
pnpm dev:up

# Run service infra without the dev server:
pnpm dev:services    # Build images, start Gitea, Trino, Kafka, Spark, Airflow

# Build
pnpm build

# Tear down everything (deletes the kind cluster — PVCs go with it, data is wiped)
pnpm dev:down
```

### Script naming

- `cluster:up` / `cluster:down` — kind cluster lifecycle. `cluster:up` also applies [`k8s/namespaces.yaml`](k8s/namespaces.yaml) so every per-service script can assume its namespace exists. `cluster:down` deletes the cluster, which kills every service and PVC inside it.
- `db:start` / `db:stop`, `gitea:start` / `gitea:stop`, `trino:start` / `trino:stop`, `airflow:start` / `airflow:stop` — per-service. Each `*:start` assumes the cluster is already up. `airflow:start` additionally assumes `db:start` has run, since Airflow's metadata DB is the existing postgres.
- `spark:image-build` / `spark:start` / `spark:stop` / `spark:logs` / `spark:submit-example` — Spark stack. `spark:image-build` builds and `kind load`s `lattik/spark-iceberg` (used only by the manual test fixtures `k8s/spark-example.yaml` and `k8s/spark-stitch-test.yaml`; NOT used by Airflow-triggered jobs). `spark:start` helm-installs the operator; `spark:submit-example` round-trips an Iceberg write+read through the same catalog Trino uses.
- `spark-drivers:sync` — populates the `spark-drivers` ConfigMap in the `workloads` namespace from `k8s/spark/drivers/`. Idempotent (create-or-update). Run automatically by `dev:services` between `spark:start` and `airflow:start`. Re-run manually after editing any driver script to pick up changes without an image rebuild.
- `stitch:spark:image-build` / `stitch:trino:image-build` / `stitch:image-build` — delegates to `./lattik-stitch/scripts/image-build.sh`. Builds the self-contained `lattik/spark-stitch` and `lattik/trino-stitch` images (Rust JNI + Kotlin/Java plugins + Iceberg runtime + Arrow deps) and kind-loads them. `stitch:image-build` builds both sequentially. Tags are versioned — see the [lattik-stitch README](lattik-stitch/README.md) for the tag scheme.
- `airflow:image-build` — builds the custom `lattik/airflow:3.2.0` image (adds `boto3` for S3 access) and loads it into the kind cluster. Must be run before `airflow:start` on a fresh cluster.
- `airflow:dags-sync` — copies DAG files from `airflow/dags/` into the kind node. Called automatically by `airflow:start`.
- `kafka:start` / `kafka:stop` / `kafka:logs` / `kafka:cli` — Kafka broker. `kafka:start` deploys a single-node KRaft broker; `kafka:cli` opens a shell in the pod (Kafka CLI tools live in `/opt/kafka/bin/`).
- `schema-registry:start` / `schema-registry:stop` / `schema-registry:logs` — Confluent Schema Registry. Requires `kafka:start` first. Stateless — schemas are stored in Kafka.
- `ingest:image-build` / `ingest:start` / `ingest:stop` / `ingest:logs` — Go ingestion service. `ingest:image-build` builds and loads the `lattik/ingest` image; `ingest:start` deploys into `workloads` ns. Requires `kafka:start` first.
- `dev:up` / `dev:services` / `dev:down` — convenience aggregations. `dev:up` brings up the prerequisites (env, cluster, postgres, schema push, seed) — everything needed before the web UI can start. `dev:services` brings up the remaining infrastructure (image builds, gitea, trino, kafka, schema-registry, ingest, spark, airflow) — automatically started in the background by `pnpm dev`. `dev:down` is an alias for `cluster:down`. Note: `spark:image-build` is NOT included — the `lattik/spark-iceberg` image is only needed for optional manual fixtures.

### Namespace layout

Each service lives in its own namespace so PVCs, secrets, and pods stay isolated. Cross-namespace references use the form `<service>.<namespace>` (e.g. Trino's iceberg catalog points at `http://iceberg-rest.iceberg:8181`). The full layout:

| Namespace | Contents |
|---|---|
| `postgres` | postgres deployment, PVC, secret, service |
| `gitea` | gitea deployment, PVC, secret, service, init Job |
| `minio` | MinIO deployment, PVC, secret, service, bucket-init Job |
| `iceberg` | iceberg-rest deployment, PVC, service, local copy of MinIO credentials secret |
| `trino` | Trino coordinator+worker deployment, configmaps, service |
| `spark-operator` | Spark Operator pod (helm-managed) |
| `kafka` | Kafka KRaft broker deployment, PVC, service |
| `schema-registry` | Confluent Schema Registry deployment, service `sr` (stateless — data in Kafka). Service named `sr` to avoid Kubernetes env var conflict with `SCHEMA_REGISTRY_*` |
| `workloads` | Spark `SparkApplication`s and the driver/executor pods they spawn, plus the `spark-driver` ServiceAccount |
| `airflow` | Airflow api-server, scheduler, dag-processor, init Job (see [`docs/infra/local-airflow.md`](docs/infra/local-airflow.md)) |

Kubernetes Secrets are namespace-scoped, so any service that needs to authenticate to MinIO from a different namespace gets its own local copy of the credentials (currently iceberg-rest and Spark drivers). Keep the values in lockstep with [`k8s/minio.yaml`](k8s/minio.yaml).

## Environment variables

Set in `apps/web/.env` (gitignored):

- `AI_GATEWAY_API_KEY` — Vercel AI Gateway auth
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://lattik:lattik-local@localhost:5432/lattik_studio`)
- `AUTH_URL` — Must be `https://lattik-studio.dev` for local dev
- `AUTH_SECRET` — NextAuth secret (generate with `openssl rand -base64 32`)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials (production only; not needed in dev where the Credentials provider is used)
- `GITEA_URL` — Gitea HTTP URL (default: `http://localhost:3300`)
- `GITEA_TOKEN` — Gitea API token (from `pnpm gitea:init-logs`)
- `GITEA_WEBHOOK_SECRET` — HMAC secret for webhook verification (generate with `openssl rand -hex 32`)
- `LATTIK_API_TOKEN` — Bearer token for the Lattik Table commit API. Must match the `LATTIK_API_TOKEN` key in the `lattik-api-credentials` secret in the `workloads` namespace ([`k8s/spark-rbac.yaml`](k8s/spark-rbac.yaml)) so Spark batch drivers can authenticate. Generate with `openssl rand -hex 32`
- `S3_ENDPOINT` — MinIO S3 API endpoint (default: `http://localhost:9000`)
- `S3_ACCESS_KEY_ID` — MinIO access key (default: `lattik`)
- `S3_SECRET_ACCESS_KEY` — MinIO secret key (default: `lattik-local`)
- `S3_DAG_BUCKET` — S3 bucket for DAG YAML specs (default: `warehouse`)
- `S3_DAG_PREFIX` — S3 key prefix for DAG YAMLs (default: `airflow-dags/`)
- `DUCKDB_EXTENSION_PATH` — (optional) path to the `lattik_stitch_duckdb.duckdb_extension` file. When set, the DuckDB client loads it on startup to enable `lattik_scan()` queries
- `LATTIK_WAREHOUSE_PATH` — S3 path prefix for Lattik Tables (default: `s3://warehouse/lattik`)

## Database

PostgreSQL runs locally in a kind (Kubernetes in Docker) cluster, backed by a `PersistentVolumeClaim` against kind's default StorageClass. Data persists across pod restarts, image upgrades, and `pnpm db:stop`/`pnpm db:start` cycles. **It does not survive `pnpm dev:down`** — that deletes the kind cluster, and the PV's backing dir lives inside the cluster's filesystem. Re-seed with `pnpm db:push && pnpm db:seed` after a recreate. Same persistence story applies to gitea, minio, and iceberg-rest.

```bash
# Start the cluster, then deploy postgres into it
pnpm cluster:up
pnpm db:start

# Push Drizzle schema to the database
pnpm db:push

# Stop just the postgres deployment (cluster keeps running, gitea/trino unaffected)
pnpm db:stop

# Tear down the entire cluster (kills postgres, gitea, trino, everything)
pnpm cluster:down

# Connect via psql (always exec into the pod — `psql` is not installed on the host)
kubectl exec -n postgres deployment/postgres -- psql -U lattik -d lattik_studio -c "SELECT 1;"
# Or open an interactive shell:
kubectl exec -it -n postgres deployment/postgres -- psql -U lattik -d lattik_studio

# Check pod status
kubectl get pods -n postgres -l app=postgres
```

- **Driver:** `postgres` (postgres.js) via `drizzle-orm/postgres-js`
- **Connection:** `src/db/index.ts` — singleton with `globalThis` for HMR safety
- **Schema:** `src/db/schema.ts` — tables: users, accounts, sessions, verificationTokens (NextAuth), conversations (chat + canvas state), definitions (pipeline definitions lifecycle), agents, user_agents (marketplace)
- **Migrations:** `drizzle-kit push` (schema-first, no migration files)
- **K8s manifests:** `k8s/kind-config.yaml` (cluster), `k8s/postgres.yaml` (PVC, Secret, Deployment, Service)
- **Port:** PostgreSQL exposed at `localhost:5432` via NodePort 30432

## Local data lake

A local mirror of the production data lake (S3 + Iceberg) running in the same kind cluster, with [Trino](https://trino.io) as the query engine. Used for developing and testing anything that touches Iceberg tables without hitting real S3. See [`docs/infra/local-data-lake.md`](docs/infra/local-data-lake.md) for the full architecture, query examples, image-pull workarounds, and troubleshooting.

```bash
# Start the data lake stack (assumes the cluster is already up)
pnpm trino:start

# Open a SQL shell against the in-cluster Trino coordinator
pnpm trino:cli

# Tail Trino logs
pnpm trino:logs

# Tear down (data is lost — PVCs go with the manifests)
pnpm trino:stop
```

- **Services:** Trino (`trinodb/trino:480`) in `trino` ns, Iceberg REST catalog (`tabulario/iceberg-rest:1.6.0`, sqlite-backed) in `iceberg` ns, MinIO in `minio` ns (object store, `warehouse` bucket)
- **K8s manifests:** `k8s/trino.yaml`, `k8s/iceberg-rest.yaml`, `k8s/minio.yaml` — each with its own PVC
- **Ports:** Trino UI / API at `localhost:8080`, MinIO S3 API at `localhost:9000`, MinIO console at `localhost:9001`
- **Catalogs registered with Trino:** `iceberg` (the local data lake), `tpch` (built-in synthetic data, no storage required — handy for smoke tests)
- **Cross-engine reads/writes:** Spark and Trino share the same iceberg-rest catalog and the same MinIO warehouse. A table written by Spark is immediately visible from Trino and vice versa. See the Local compute section below.
- **Persistence:** all PVC-backed via kind's default StorageClass; survives pod restarts but **not** `pnpm dev:down`. Snapshot via `mc cp` or `pg_dump` if you need cross-recreate persistence.

## Local compute (Spark)

Apache Spark 4.0.2 with the Iceberg 1.10.1 runtime, run as `SparkApplication` resources under [kubeflow's Spark Operator](https://github.com/kubeflow/spark-operator). Used for batch jobs that read or write Iceberg tables — the same tables Trino can query. The custom image bakes the Iceberg Spark runtime + iceberg-aws-bundle into `apache/spark:4.0.2`. See [`docs/infra/local-data-lake.md`](docs/infra/local-data-lake.md) for the architecture diagram and an end-to-end example.

```bash
# One-time (and after editing k8s/spark/Dockerfile): build + kind load
pnpm spark:image-build

# Helm-install the Spark Operator into the spark-operator namespace and apply the workloads RBAC
pnpm spark:start

# Submit the example SparkApplication that round-trips an Iceberg write+read
pnpm spark:submit-example

# Tail the operator's logs (separate from any individual SparkApplication's driver logs)
pnpm spark:logs

# Uninstall the operator and delete the workloads RBAC
pnpm spark:stop
```

- **Operator:** `kubeflow/spark-operator` Helm chart, installed in the `spark-operator` namespace; configured to watch the `workloads` namespace for `SparkApplication` CRDs.
- **Images (dual):**
  - `lattik/spark-stitch:0.1.0-spark4.0.2-iceberg1.10.1` — self-contained image built by [`lattik-stitch`](lattik-stitch/). Includes Iceberg Spark runtime, hadoop-aws, AWS SDK v2, the Kotlin DS V2 stitch plugin (`lattik-spark.jar`), and the Rust JNI native lib. Used by all Airflow-triggered Lattik Table materialization jobs via [`airflow/dags/spark_app_template.yaml`](airflow/dags/spark_app_template.yaml). Build with `pnpm stitch:spark:image-build`. Tag scheme and versioning are documented in the [lattik-stitch README](lattik-stitch/README.md). Bumping the stitch version means: editing `VERSION` in lattik-stitch, rebuilding, and updating the `image:` line in `spark_app_template.yaml` to match the new tag.
  - `lattik/spark-iceberg:4.0.2-1.10.1` — lightweight image built from [`k8s/spark/Dockerfile`](k8s/spark/Dockerfile), containing only the Iceberg runtime + hadoop-aws (no stitch plugin). Used only by manual test fixtures ([`k8s/spark-example.yaml`](k8s/spark-example.yaml) and [`k8s/spark-stitch-test.yaml`](k8s/spark-stitch-test.yaml)). Build with `pnpm spark:image-build`. NOT included in `pnpm dev:up` or `images:build` — run it manually before using those fixtures.
- **Driver scripts:** The Python driver scripts (`lattik_table_driver.py`, `lattik_table_backfill.py`, `lattik_driver_utils.py`) live in [`k8s/spark/drivers/`](k8s/spark/drivers/) and are mounted into SparkApplication pods at `/opt/spark/work-dir/` via the `spark-drivers` ConfigMap. Populated by `pnpm spark-drivers:sync` (included in `dev:up`). Editing a driver requires only `pnpm spark-drivers:sync` — no image rebuild needed. The stitch image does NOT bake these scripts in.
- **Trino stitch image:** `lattik/trino-stitch:0.1.0-trino480` is built by lattik-stitch (`pnpm stitch:trino:image-build`) but is NOT yet wired into [`k8s/trino.yaml`](k8s/trino.yaml), which still runs stock `trinodb/trino:480`. Wiring it in requires adding a `lattik` catalog entry to the Trino config — a future step.
- **K8s manifests:** [`k8s/spark/Dockerfile`](k8s/spark/Dockerfile), [`k8s/spark/operator-values.yaml`](k8s/spark/operator-values.yaml), [`k8s/spark-rbac.yaml`](k8s/spark-rbac.yaml) (`spark-driver` ServiceAccount + Role + RoleBinding + local copy of MinIO credentials), [`k8s/spark-example.yaml`](k8s/spark-example.yaml) (a ConfigMap-mounted PySpark script + a `SparkApplication` that creates `iceberg.spark_demo.events` and writes three rows).
- **Iceberg catalog config:** every SparkApplication needs the same set of `spark.sql.catalog.iceberg.*` properties — see [`k8s/spark-example.yaml`](k8s/spark-example.yaml#L93-L113) for the canonical set. The two non-obvious bits: `spark.sql.extensions` must include `IcebergSparkSessionExtensions`, and `AWS_REGION` must be set as an env var on driver and executor pods (not just in sparkConf — the parquet writer code path uses the SDK's default chain, which doesn't see sparkConf).
- **Persistence:** the operator pod itself is stateless; the `workloads` namespace has no long-lived PVCs. Driver/executor pods are created and torn down per-job. Output data lives in MinIO via the iceberg-rest catalog.
- **Helm dependency:** `helm` is required as a host-side prereq for `pnpm spark:start`. Install via `brew install helm` on macOS.

## Local orchestration (Airflow)

Apache Airflow 3.2.0 runs in the same kind cluster, with `KubernetesExecutor` so each task spawns its own pod. The metadata DB is the existing `postgres` Service (a separate `airflow` database, created idempotently by an init Job). DAGs come from a hostPath mount — drop a `.py` file in `/var/lib/lattik/airflow-dags/` (or symlink the repo's `airflow/dags/` into it) and the DAG processor picks it up on its next scan, no restart needed. See [`docs/infra/local-airflow.md`](docs/infra/local-airflow.md) for the full architecture, DAG authoring workflow, providers / custom-image pattern, upgrade procedure, and troubleshooting.

```bash
# Start Airflow (assumes cluster + postgres are already up)
pnpm airflow:start

# Stop just Airflow
pnpm airflow:stop

# Tail scheduler logs
pnpm airflow:logs

# Tail the init Job's logs (db migrate output)
pnpm airflow:init-logs
```

- **Components:** `api-server` (Airflow 3 replaces `webserver`), `scheduler`, `dag-processor` (now mandatory in Airflow 3 — used to live inside the scheduler in 2.x), one-shot `airflow-init` Job for DB create + migrate. Worker pods are spawned by the scheduler on demand and torn down on completion.
- **K8s manifest:** [`k8s/airflow.yaml`](k8s/airflow.yaml) — single file with RBAC, Secret, shared env ConfigMap, pod-template ConfigMap, init Job, the three Deployments, and the api-server NodePort Service.
- **Auth:** `SimpleAuthManager` in all-admins mode (`AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_ALL_ADMINS=True`) — no credentials, click Sign In. **Local dev only.** Same approach as `projects/testenv`.
- **UI:** <http://localhost:8088> via NodePort 30888 (mapped in [`k8s/kind-config.yaml`](k8s/kind-config.yaml)).
- **DAG source:** hostPath `/var/lib/lattik/airflow-dags/` → `/opt/airflow/dags` inside every airflow pod (api-server, scheduler, dag-processor, workers). The repo ships a sample DAG at `airflow/dags/example_dag.py` — copy or symlink it into the host dir.
- **Logs:** hostPath `/var/lib/lattik/airflow-logs/` → `/opt/airflow/logs`. Worker logs survive pod deletion, so the UI can show task logs even after `delete_worker_pods=True` removes the executor pod.
- **Metadata DB:** `airflow` database in the existing postgres. **Wiped on `pnpm dev:down`** along with everything else. To upgrade Airflow versions in place, the schema migration path between majors is non-trivial — for local dev it's faster to `DROP DATABASE airflow` and re-run `pnpm airflow:start`.
- **Worker → api-server traffic:** Airflow 3 workers no longer connect to postgres directly — they hit the api-server's execution API at `AIRFLOW__CORE__EXECUTION_API_SERVER_URL=http://airflow-api-server:8080/execution/`. JWT auth is configured via `AIRFLOW__API_AUTH__JWT_SECRET`.
- **Custom image:** `lattik/airflow:3.2.0` (built from [`k8s/airflow/Dockerfile`](k8s/airflow/Dockerfile)). Installs the [`lattik-airflow`](packages/lattik-airflow/) package (which pulls in `boto3` and `apache-airflow-providers-cncf-kubernetes` as deps). Build and load with `pnpm airflow:image-build`. All Airflow pods (api-server, scheduler, dag-processor, workers) use this image.
- **DAG rendering from S3:** The file `airflow/dags/lattik_dag_renderer.py` reads YAML DAG specs from `s3://warehouse/airflow-dags/` (MinIO) at import time and dynamically creates Airflow `DAG` objects via `globals()` injection. YAML specs are generated by the web app (`src/lib/dag-generator.ts`) when a Gitea PR merges (triggered by the webhook handler). Two task types: `wait` (custom `DataReadySensor` that pokes the Iceberg REST catalog) and `spark` (`SparkKubernetesOperator` using the Jinja template at `airflow/dags/spark_app_template.yaml`).

## Local messaging (Kafka)

Apache Kafka 3.9.0 runs in KRaft mode (no ZooKeeper) as a single combined controller+broker node. Used for event streaming between services in the cluster.

```bash
# Start Kafka (assumes the cluster is already up)
pnpm kafka:start

# Stop just Kafka
pnpm kafka:stop

# Tail broker logs
pnpm kafka:logs

# Shell into the pod (Kafka CLI tools in /opt/kafka/bin/)
pnpm kafka:cli
```

- **Image:** `apache/kafka:3.9.0` (KRaft-native, no ZooKeeper dependency).
- **K8s manifest:** [`k8s/kafka.yaml`](k8s/kafka.yaml) — PVC, Deployment (Recreate strategy), NodePort Service.
- **Listeners:** `PLAINTEXT://:9092` (in-cluster, advertised as `kafka.kafka:9092`) and `EXTERNAL://:9094` (host access, advertised as `localhost:9094` via NodePort 30094).
- **In-cluster access:** `kafka.kafka:9092` — use this from Spark jobs, Airflow tasks, or any other in-cluster service.
- **Host access:** `localhost:9094` via NodePort 30094 (mapped in [`k8s/kind-config.yaml`](k8s/kind-config.yaml)). Requires cluster recreate if the kind-config mapping was added after cluster creation; use `kubectl -n kafka port-forward svc/kafka 9094:9094` as a workaround.
- **Topics:** `auto.create.topics.enable=true` — topics are created on first produce. To manage manually, use `kafka:cli` and run `/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic <name>`.
- **Persistence:** PVC-backed (`kafka-data`, 5 Gi). Survives pod restarts but **not** `pnpm dev:down`. Same story as all other services.
- **Replication:** all replication factors set to 1 (single-node local dev — no HA).

## Auth

- Provider gated by `NODE_ENV` in `src/auth/index.ts`:
  - **Local dev (`NODE_ENV=development`):** Credentials provider — sign in with `admin` / `admin`. First sign-in upserts a single `admin@lattik.local` user. No Google OAuth setup required.
  - **Production:** Google OAuth.
- `src/proxy.ts` protects all routes; unauthenticated users redirect to `/sign-in`
- API routes (`/api/chat`) also check auth explicitly
- Webhook routes (`/api/webhooks/*`) excluded from middleware, verified via HMAC
- Google Console redirect URI (prod only): `https://lattik-studio.dev/api/auth/callback/google`

## Extensions

Each extension has a `README.md` documenting its agent architecture, tools, canvas components, and workflows. Read the extension's README before making changes.

### Canvas Rules
All canvas UI MUST be rendered via `@json-render/react`. Define catalogs with `defineCatalog()`, register components with `defineRegistry()`, render with `<Renderer>`. State is managed by json-render's JSON Pointer state model (`$state`, `$bindState`, `setState` actions). The LLM streams JSONL patches via `pipeJsonRender()`, client applies them with `useJsonRenderMessage()`. Do NOT bypass json-render with custom renderers or direct React state for canvas content. Conversation and canvas state MUST survive page refresh — the full spec + state is persisted to the database and restored on load.

## Design

- Dark glassmorphic theme with frosted glass effects
- Fonts: Inter (sans), Geist Mono (mono), Homemade Apple (display)
- Accent color: `#e0a96e` (amber)
- Branding: "Lattik" in display font + "Studio" in amber
