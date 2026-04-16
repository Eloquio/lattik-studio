# Lattik

Open-source data platform by [Eloquio](https://github.com/Eloquio). Lattik combines an agentic analytics studio, a columnar stitch engine, and an expression language into a unified stack for building and operating data pipelines on top of S3 + Iceberg.

**Lattik Studio** is the agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. It connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Data Architect, a Root Cause Analysis Agent). Extension authors define the agent logic and what renders on the canvas (charts, tables, YAML editors, etc.).

## Features

- Three-column layout: nav sidebar, chat panel, resizable canvas
- Dark frosted glass (glassmorphic) theme
- Agentic chat powered by Vercel AI Gateway (Claude Sonnet 4)
- Extension framework for building specialized AI agents
- Streaming canvas rendered with [`@json-render/react`](https://github.com/vercel-labs/json-render); conversation + canvas state persisted to Postgres and restored on reload
- Google OAuth via NextAuth (Auth.js v5)
- Local PostgreSQL via a kind (Kubernetes in Docker) cluster, managed with Drizzle ORM
- Local Gitea (also in kind) for the pipeline PR review workflow
- Local data lake stack — Trino + Iceberg REST catalog + MinIO + Spark Operator + Spark 4.0 (with Iceberg), all in the same kind cluster ([details](docs/local-data-lake.md))
- Local Airflow 3.2 (KubernetesExecutor) in the same kind cluster for orchestration ([details](docs/local-airflow.md))
- shadcn/ui components (Base Nova style)
- Inter + Geist Mono + Homemade Apple fonts

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 + AI Gateway (Claude Sonnet 4)
- **Auth:** NextAuth v5 (Auth.js beta) with Google provider
- **Database:** PostgreSQL (local via kind) + Drizzle ORM
- **Local data lake:** Trino + Iceberg REST catalog + MinIO, all in the same kind cluster
- **Local compute:** Spark 4.0.2 with Iceberg 1.10.1, run as Spark Operator (kubeflow) `SparkApplication`s in a `workloads` namespace
- **Orchestration:** Airflow 3.2.0 (KubernetesExecutor) in the same kind cluster, sharing the postgres metadata DB
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** [portless](https://github.com/vercel-labs/portless) (`https://lattik-studio.dev` via `--tld dev`)
- **Canvas rendering:** [`@json-render/core`](https://github.com/vercel-labs/json-render) + `@json-render/react`
- **Expression engine:** `@eloquio/lattik-expression` (parse, type-check, emit SQL)
- **Messaging:** Apache Kafka 3.9.0 (KRaft, no ZooKeeper) + Confluent Schema Registry 7.7.0 for Protobuf payload schemas
- **Ingestion:** Go HTTP service (`apps/ingest/`) — accepts Protobuf envelopes, deduplicates, and produces to per-table Kafka topics
- **Logger SDK:** `@eloquio/lattik-logger` (Protobuf envelope + typed clients for Logger Tables, auto-generated `.proto` per table via `buf`)
- **Git (local dev):** Gitea in kind cluster for the PR review workflow

## Getting Started

### System requirements

- macOS, Linux, or Windows (WSL2)
- 12+ GB RAM recommended (8 GB minimum — the full stack runs ~10 services in a local Kubernetes cluster)
- 20+ GB free disk space (Docker images, kind PVCs)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (make sure Docker Desktop is running)
- [kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [portless](https://github.com/nicolo-ribaudo/portless) (`npm install -g portless`)
- [helm](https://helm.sh/) (for Spark Operator)

### Setup

```bash
# Start the HTTPS proxy (requires sudo for port 443 — serves lattik-studio.dev)
sudo portless proxy start --tld dev

# Clone
git clone https://github.com/Eloquio/lattik-studio.git
cd lattik-studio

# Install dependencies
pnpm install

# Start everything — preflight checks, environment setup, services, and dev server
pnpm dev:up
```

`pnpm dev:up` runs through these phases automatically:

1. **Preflight checks** — validates Docker, kind, helm, Node, pnpm, RAM, disk, and port availability
2. **Environment bootstrap** — generates `apps/web/.env` (prompts for your AI Gateway key, auto-generates all secrets)
3. **Required services** — creates the kind cluster, starts PostgreSQL, pushes the DB schema, and seeds data
4. **Dev server** — starts the Next.js app at https://lattik-studio.dev
5. **Background services** — builds images and starts Gitea, Trino, MinIO, Kafka, Spark, Airflow, etc. (progress logged to `.dev-services.log`)

First run takes **15-20 minutes** (image builds + container pulls). Subsequent runs take ~2 minutes.

Sign in with **admin / admin** — no Google OAuth setup required for local development.

### Verify

Check the status of all services at any time:

```bash
pnpm dev:status
```

### Teardown

```bash
pnpm dev:down   # Deletes the kind cluster — all data is wiped
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
