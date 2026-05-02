# Lattik Studio Docs

Documentation is grouped by purpose. Start with [features.md](features.md) for the high-level pitch, [tech-stack.md](tech-stack.md) for the dependency map, or [architecture/concepts.md](architecture/concepts.md) for the agent/skill model.

## Top-level

| Doc | Description |
|-----|-------------|
| [features.md](features.md) | Feature overview |
| [tech-stack.md](tech-stack.md) | Full technology stack |
| [end-to-end-test-plan.md](end-to-end-test-plan.md) | Manual smoke-test checklist that exercises the full pipeline |

## architecture/

Cross-cutting concepts and the data model. Read these to understand how the agents, skills, and pipeline definitions fit together.

| Doc | Description |
|-----|-------------|
| [concepts.md](architecture/concepts.md) | Agents, skills, tools, runtimes — and how they compose |
| [data-model.md](architecture/data-model.md) | Entities, dimensions, logger tables, lattik tables, metrics |
| [agent-handoff.md](architecture/agent-handoff.md) | Assistant ↔ Specialist handoff protocol with depth-1 task stack |
| [progressive-disclosure.md](architecture/progressive-disclosure.md) | Progressive-disclosure patterns used across the canvas UI |

## canvas/

How chat-side canvases are rendered and designed.

| Doc | Description |
|-----|-------------|
| [canvas-rendering.md](canvas/canvas-rendering.md) | json-render streaming, spec parts, state binding |
| [canvas-design-principles.md](canvas/canvas-design-principles.md) | UX guidelines for canvas components |

## extensions/

Per-extension architecture and workflows. Each extension also has a `README.md` next to its source under `apps/web/src/extensions/<name>/`.

| Doc | Description |
|-----|-------------|
| [data-analyst.md](extensions/data-analyst.md) | Data Analyst — SQL exploration + charts |
| [pipeline-manager.md](extensions/pipeline-manager.md) | Pipeline Manager — data ecosystem reliability (Logger Tables + Airflow DAGs) |

## infra/

Operational guides for the local-dev infrastructure (kind cluster, data lake, orchestration, batch compute).

| Doc | Description |
|-----|-------------|
| [local-data-lake.md](infra/local-data-lake.md) | Trino + Iceberg REST + MinIO + Spark Operator |
| [local-airflow.md](infra/local-airflow.md) | Airflow 3.x orchestration |
| [lattik-table-stitch.md](infra/lattik-table-stitch.md) | Stitch engine for Lattik Tables |

## archive/

Historical design plans. Useful for context on why things are the way they are; not authoritative for current behavior. The repo's [CLAUDE.md](../CLAUDE.md) and the docs above are the source of truth.

| Doc | Description |
|-----|-------------|
| [PLAN-skill-based-worker-loop.md](archive/PLAN-skill-based-worker-loop.md) | Original plan for the skill-based worker loop (now implemented; superseded by [architecture/concepts.md](architecture/concepts.md)) |
| [PLAN-worker-deployment-and-capabilities.md](archive/PLAN-worker-deployment-and-capabilities.md) | Worker deployment + (since-dropped) capability model |
| [PLAN-improve-local-setup.md](archive/PLAN-improve-local-setup.md) | Plan that drove the current `pnpm dev:up` flow |
| [PLAN-duckdb-stitch-extension.md](archive/PLAN-duckdb-stitch-extension.md) | DuckDB stitch extension exploration |
