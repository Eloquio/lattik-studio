# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Lattik Studio connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

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

For setup instructions, see the [root README](../README.md#getting-started).
