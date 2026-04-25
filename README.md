# Lattik

Open-source data platform by [Datability LLC](https://github.com/Eloquio). Lattik combines an agentic analytics studio, a columnar stitch engine, and an expression language into a unified stack for building and operating data pipelines on top of S3 + Iceberg.

**Lattik Studio** is the agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering.

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

# Install dependencies
pnpm install

# Bootstrap — preflight checks, .env generation, cluster + Postgres + schema + seed
pnpm dev:bootstrap

# Start background services + dev server
pnpm dev:up
```

Sign in with **admin / admin** — no Google OAuth setup required for local development.

### Commands

| Command | Description |
|---|---|
| `pnpm dev:bootstrap` | Preflight checks, `.env` generation, cluster + Postgres + schema + seed |
| `pnpm dev:up` | Background services + dev server (run bootstrap first) |
| `pnpm dev:web` | Dev server only (Next.js + agent-worker via Turbo) |
| `pnpm dev:services` | Build images, start Gitea, Trino, Kafka, Spark, Airflow, etc. |
| `pnpm dev:status` | Check the status of all services |
| `pnpm dev:down` | Delete the kind cluster (all data is wiped) |

First run takes ~15 minutes (image pulls); subsequent runs take ~2 minutes.

## Documentation

See [docs/README.md](docs/README.md) for the full index. Highlights:

| Doc | Description |
|-----|-------------|
| [Features](docs/features.md) | Feature overview |
| [Tech Stack](docs/tech-stack.md) | Full technology stack |
| [Concepts](docs/architecture/concepts.md) | Core concepts: agents, skills, tools, runtimes |
| [Data Model](docs/architecture/data-model.md) | Entities, dimensions, logger/lattik tables, metrics |
| [Agent Handoff](docs/architecture/agent-handoff.md) | Multi-agent handoff protocol |
| [Canvas Rendering](docs/canvas/canvas-rendering.md) | json-render streaming canvas |
| [Canvas Design Principles](docs/canvas/canvas-design-principles.md) | Canvas UX guidelines |
| [Local Data Lake](docs/infra/local-data-lake.md) | Trino + Iceberg + MinIO + Spark setup |
| [Local Airflow](docs/infra/local-airflow.md) | Airflow 3.x orchestration |
| [Lattik Table Stitch](docs/infra/lattik-table-stitch.md) | Stitch engine for Lattik Tables |
| [Data Analyst extension](docs/extensions/data-analyst.md) | SQL exploration + charts |
| [Pipeline Manager extension](docs/extensions/pipeline-manager.md) | Airflow DAG monitoring + troubleshooting |

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. All contributors must sign the [Contributor License Agreement](CLA.md) — the CLA bot will prompt you on your first PR.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details. Copyright 2025-2026 Datability LLC.
