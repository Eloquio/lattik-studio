# Lattik

Open-source data platform by [Eloquio](https://github.com/Eloquio). Lattik combines an agentic analytics studio, a columnar stitch engine, and an expression language into a unified stack for building and operating data pipelines on top of S3 + Iceberg.

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

## Documentation

| Doc | Description |
|-----|-------------|
| [Features](docs/features.md) | Feature overview |
| [Tech Stack](docs/tech-stack.md) | Full technology stack |
| [Data Model](docs/data-model.md) | Core data model and schema |
| [Local Data Lake](docs/local-data-lake.md) | Trino + Iceberg + MinIO + Spark setup |
| [Local Airflow](docs/local-airflow.md) | Airflow 3.x orchestration |
| [Canvas Rendering](docs/canvas-rendering.md) | json-render streaming canvas |
| [Canvas Design Principles](docs/canvas-design-principles.md) | Canvas UX guidelines |
| [Progressive Disclosure](docs/progressive-disclosure.md) | Progressive disclosure patterns |
| [Agent Handoff](docs/agent-handoff.md) | Multi-agent handoff protocol |
| [Lattik Table Stitch](docs/lattik-table-stitch.md) | Stitch engine for Lattik Tables |
| [Pipeline Manager](docs/pipeline-manager.md) | Pipeline management |

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
