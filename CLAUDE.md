# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Root Cause Analysis Agent). Extension authors define agent logic and what renders on the canvas (charts, tables, etc.).

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 with AI Gateway (Claude Sonnet 4)
- **Auth:** NextAuth v5 (Auth.js beta) with Google OAuth
- **Database:** PostgreSQL (local via kind) + Drizzle ORM
- **Local data lake:** Trino + Iceberg REST catalog + MinIO, all in kind ([`docs/local-data-lake.md`](docs/local-data-lake.md))
- **Orchestration (local dev):** Airflow 3.2.0 with KubernetesExecutor in the same kind cluster, sharing the postgres metadata DB ([`docs/local-airflow.md`](docs/local-airflow.md))
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** portless (`https://lattik-studio.dev` via `--tld dev`)
- **Canvas rendering:** `@json-render/core` + `@json-render/react` ([vercel-labs/json-render](https://github.com/vercel-labs/json-render))
- **Expression engine:** `@eloquio/lattik-expression` (parse, type-check, emit SQL)
- **Git (local dev):** Gitea in kind cluster for PR review workflow

## Project structure

```
apps/web/              Next.js app
  src/app/             Pages and API routes
  src/auth/            NextAuth config (Google provider, Drizzle adapter)
  src/components/      UI components (chat, canvas, layout, ui)
  src/db/              Drizzle schema and connection
  src/extensions/      Extension framework and agents
    data-architect/    Data Architect extension (see README.md inside)
      canvas/          Canvas components + json-render system
      skills/          Skill markdown docs (entity, dimension, logger table, lattik table, metric)
      tools/           Agent tools (getSkill, renderCanvas, staticCheck, submitPR, etc.)
      validation/      Naming, referential, and expression validation
  src/hooks/           React hooks
  src/lib/             Server actions and utilities
  src/proxy.ts         Auth middleware (protects all routes except /sign-in, /api/auth, /api/webhooks)
docs/                  Architecture docs (agent-handoff, canvas-rendering, progressive-disclosure, data-model, local-data-lake, local-airflow)
k8s/                   Kubernetes manifests (kind cluster, PostgreSQL, Gitea, Trino + iceberg-rest + MinIO, Airflow)
airflow/dags/          Local Airflow DAGs (hostPath-mounted into the airflow pods — edit live, no restart)
packages/              Shared packages (future)
```

## Development

```bash
# Bring up the full dev stack: kind cluster + postgres + gitea + trino/minio/iceberg-rest + airflow
pnpm dev:up

# Or, for a minimum env (cluster + postgres only — much faster, ~6 GB less RAM):
pnpm cluster:up && pnpm db:start

# Push database schema
pnpm db:push

# If gitea is running, grab the API token from the init logs and set GITEA_TOKEN in apps/web/.env
pnpm gitea:init-logs

# Start portless proxy with .dev TLD (required for Google OAuth)
portless proxy start --tld dev

# Run dev server (serves at https://lattik-studio.dev)
pnpm dev

# Build
pnpm build

# Tear down everything (deletes the kind cluster — PVCs go with it, data is wiped)
pnpm dev:down
```

### Script naming

- `cluster:up` / `cluster:down` — kind cluster lifecycle only. `cluster:down` deletes the cluster, which kills every service inside it.
- `db:start` / `db:stop`, `gitea:start` / `gitea:stop`, `trino:start` / `trino:stop`, `airflow:start` / `airflow:stop` — per-service. Each `*:start` assumes the cluster is already up. `airflow:start` additionally assumes `db:start` has run, since Airflow's metadata DB is the existing postgres.
- `dev:up` / `dev:down` — convenience aggregations. `dev:up` brings up the cluster + every service in sequence; `dev:down` is an alias for `cluster:down`.

## Environment variables

Set in `apps/web/.env` (gitignored):

- `AI_GATEWAY_API_KEY` — Vercel AI Gateway auth
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://lattik:lattik-local@localhost:5432/lattik_studio`)
- `AUTH_URL` — Must be `https://lattik-studio.dev` for local dev
- `AUTH_SECRET` — NextAuth secret (generate with `openssl rand -base64 32`)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials
- `GITEA_URL` — Gitea HTTP URL (default: `http://localhost:3300`)
- `GITEA_TOKEN` — Gitea API token (from `pnpm gitea:init-logs`)
- `GITEA_WEBHOOK_SECRET` — HMAC secret for webhook verification (generate with `openssl rand -hex 32`)

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

# Connect via psql
psql postgresql://lattik:lattik-local@localhost:5432/lattik_studio

# Check pod status
kubectl get pods -l app=postgres
```

- **Driver:** `postgres` (postgres.js) via `drizzle-orm/postgres-js`
- **Connection:** `src/db/index.ts` — singleton with `globalThis` for HMR safety
- **Schema:** `src/db/schema.ts` — tables: users, accounts, sessions, verificationTokens (NextAuth), conversations (chat + canvas state), definitions (pipeline definitions lifecycle), agents, user_agents (marketplace)
- **Migrations:** `drizzle-kit push` (schema-first, no migration files)
- **K8s manifests:** `k8s/kind-config.yaml` (cluster), `k8s/postgres.yaml` (PVC, Secret, Deployment, Service)
- **Port:** PostgreSQL exposed at `localhost:5432` via NodePort 30432

## Local data lake

A local mirror of the production data lake (S3 + Iceberg) running in the same kind cluster, with [Trino](https://trino.io) as the query engine. Used for developing and testing anything that touches Iceberg tables without hitting real S3. See [`docs/local-data-lake.md`](docs/local-data-lake.md) for the full architecture, query examples, image-pull workarounds, and troubleshooting.

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

- **Services:** Trino (`trinodb/trino:480`), Iceberg REST catalog (`tabulario/iceberg-rest:1.6.0`, sqlite-backed), MinIO (object store, `warehouse` bucket)
- **K8s manifests:** `k8s/trino.yaml`, `k8s/iceberg-rest.yaml`, `k8s/minio.yaml` — each with its own PVC
- **Ports:** Trino UI / API at `localhost:8080`, MinIO S3 API at `localhost:9000`, MinIO console at `localhost:9001`
- **Catalogs registered with Trino:** `iceberg` (the local data lake), `tpch` (built-in synthetic data, no storage required — handy for smoke tests)
- **Persistence:** all PVC-backed via kind's default StorageClass; survives pod restarts but **not** `pnpm dev:down`. Snapshot via `mc cp` or `pg_dump` if you need cross-recreate persistence.

## Local orchestration (Airflow)

Apache Airflow 3.2.0 runs in the same kind cluster, with `KubernetesExecutor` so each task spawns its own pod. The metadata DB is the existing `postgres` Service (a separate `airflow` database, created idempotently by an init Job). DAGs come from a hostPath mount — drop a `.py` file in `/var/lib/lattik/airflow-dags/` (or symlink the repo's `airflow/dags/` into it) and the DAG processor picks it up on its next scan, no restart needed. See [`docs/local-airflow.md`](docs/local-airflow.md) for the full architecture, DAG authoring workflow, providers / custom-image pattern, upgrade procedure, and troubleshooting.

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
- **Providers:** none preinstalled (bare `apache/airflow:3.2.0`). To talk to Trino, MinIO, or anything else, build a custom image with the relevant `apache-airflow-providers-*` packages baked in. Avoid `_PIP_ADDITIONAL_REQUIREMENTS` — it pip-installs on every pod start, which is slow and flaky.

## Auth

- Google OAuth only, configured in `src/auth/index.ts`
- `src/proxy.ts` protects all routes; unauthenticated users redirect to `/sign-in`
- API routes (`/api/chat`) also check auth explicitly
- Webhook routes (`/api/webhooks/*`) excluded from middleware, verified via HMAC
- Google Console redirect URI: `https://lattik-studio.dev/api/auth/callback/google`

## Extensions

Each extension has a `README.md` documenting its agent architecture, tools, canvas components, and workflows. Read the extension's README before making changes.

### Canvas Rules
All canvas UI MUST be rendered via `@json-render/react`. Define catalogs with `defineCatalog()`, register components with `defineRegistry()`, render with `<Renderer>`. State is managed by json-render's JSON Pointer state model (`$state`, `$bindState`, `setState` actions). The LLM streams JSONL patches via `pipeJsonRender()`, client applies them with `useJsonRenderMessage()`. Do NOT bypass json-render with custom renderers or direct React state for canvas content. Conversation and canvas state MUST survive page refresh — the full spec + state is persisted to the database and restored on load.

## Design

- Dark glassmorphic theme with frosted glass effects
- Fonts: Inter (sans), Geist Mono (mono), Homemade Apple (display)
- Accent color: `#e0a96e` (amber)
- Branding: "Lattik" in display font + "Studio" in amber
