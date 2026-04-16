# Tech Stack

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
