# Data Analyst Agent

The Data Analyst is a specialist agent in Lattik Studio that helps users explore data via SQL against Trino, returning results as tables and charts on a multi-panel canvas. It's the read-side counterpart to the Data Architect (which defines the schemas this agent queries).

## Architecture

```
User ←→ Chat ←→ Agent (Claude Sonnet 4.6) ←→ Tools ←→ Trino / Canvas
```

The agent is a `ToolLoopAgent` (Vercel AI SDK v6) with a max of 10 tool steps per turn. It loads a skill markdown doc via `getSkill` before starting work — the skill is the source of truth for the workflow, not memory. Where data-architect's canvas shows one form at a time, data-analyst's canvas is multi-panel: SQL editor, query stats, results table, and chart can all be visible together.

### Key Behavior
- **Skill-driven:** Every workflow starts with `getSkill`. Currently one skill: [`exploring-data`](skills/exploring-data.md).
- **Render-tool-only canvas:** Unlike data-architect (which streams `spec` code fences), this agent uses dedicated render tools (`renderSqlEditor`, `renderChart`) and never emits raw spec fences.
- **Definition-aware:** The agent can read pipeline definitions via `listDefinitions` / `getDefinition` (borrowed from data-architect) so it suggests queries that align with declared entities, dimensions, and tables.
- **Read-only:** `DROP`, `DELETE`, `TRUNCATE`, and any other destructive DDL/DML are out of scope. If the user asks to delete a table, the agent hands back to the assistant.

## Tools

| Tool | Purpose |
|------|---------|
| `getSkill` | Load a skill markdown document by ID |
| `listTables` | Discover catalogs, schemas, and tables in Trino |
| `describeTable` | Inspect a table's column schema |
| `renderSqlEditor` | Render a SQL editor on the canvas, pre-populated |
| `runQuery` | Execute SQL against Trino and stream results back into canvas state |
| `renderChart` | Render a chart panel (bar, line, area, pie, scatter) bound to query results |
| `readCanvasState` | Read the current canvas state (e.g. user-edited SQL) |
| `updateLayout` | Reorder or hide canvas panels |
| `listDefinitions` | List existing pipeline definitions (entity, dimension, etc.) |
| `getDefinition` | Fetch a specific definition by kind and name |
| `handback` | Return control from the agent (`pause` for off-topic, `complete` when done) |

## Canvas

The canvas uses `@json-render/react` for all rendering. State is mutable across tool calls within a request — `runQuery` writes results into state, then `renderChart` reads them — so panels update without a full spec rebuild.

### Layout
A single `AnalystLayout` element holds an `elements` map with `sql`, `stats`, `results`, and `chart` children. Panels become visible as the workflow progresses:

1. `renderSqlEditor` → SQL editor visible
2. `runQuery` → stats + results table visible
3. `renderChart` → chart visible

See [`docs/extensions/data-analyst.md`](../../../../../docs/extensions/data-analyst.md) for the full design rationale and spec shape.

## Data Sources

Trino is configured with two catalogs:
- **`iceberg`** — the local data lake (Logger Tables, Lattik Tables, anything else under the `warehouse` MinIO bucket)
- **`tpch`** — built-in synthetic TPC-H data, useful for demos and smoke tests

Use fully qualified names (`catalog.schema.table`) in all queries.

## File Structure

```
data-analyst/
├── agent.ts              Agent definition (ToolLoopAgent, instructions, tools)
├── register.ts           Extension registration
├── spec-builder.ts       Deterministic builder: state -> json-render spec
├── canvas/
│   ├── data-analyst-canvas.tsx  Root canvas component
│   ├── catalog.ts               json-render catalog definition
│   └── registry.tsx             Component registry (SqlEditor, charts, etc.)
├── lib/                  Helper modules (chart-type inference, query result shaping)
├── skills/
│   ├── index.ts                 Skill metadata and loader
│   └── exploring-data.md        Browse → query → visualize workflow
└── tools/
    ├── get-skill.ts             Load skill documents
    ├── list-tables.ts           Discover Trino catalogs/schemas/tables
    ├── describe-table.ts        Inspect table schema
    ├── render-sql-editor.ts     Render the SQL editor panel
    ├── run-query.ts             Execute against Trino
    ├── render-chart.ts          Render the chart panel
    ├── read-canvas-state.ts     Read current canvas state
    └── update-layout.ts         Reorder/hide panels
```
