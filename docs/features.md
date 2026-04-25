# Features

- Three-column layout: nav sidebar, chat panel, resizable canvas
- Dark frosted glass (glassmorphic) theme
- Agentic chat powered by Vercel AI Gateway (Claude Sonnet 4.6 for chat agents, Claude Haiku 4.5 for canvas streaming)
- Extension framework for building specialized AI agents
- Streaming canvas rendered with [`@json-render/react`](https://github.com/vercel-labs/json-render); conversation + canvas state persisted to Postgres and restored on reload
- Google OAuth via NextAuth (Auth.js v5)
- Local PostgreSQL via a kind (Kubernetes in Docker) cluster, managed with Drizzle ORM
- Local Gitea (also in kind) for the pipeline PR review workflow
- Local data lake stack — Trino + Iceberg REST catalog + MinIO + Spark Operator + Spark 4.0 (with Iceberg), all in the same kind cluster ([details](infra/local-data-lake.md))
- Local Airflow 3.2 (KubernetesExecutor) in the same kind cluster for orchestration ([details](infra/local-airflow.md))
- shadcn/ui components (Base Nova style)
- Inter + Geist Mono + Homemade Apple fonts
