# Data Analyst Agent

Design plan for the Data Analyst extension — an agentic assistant that helps users query data and visualize results interactively.

## Concept

Where the Data Architect defines pipeline *structure* (schemas, tables, metrics), the Data Analyst *uses* that structure — running SQL against Trino, displaying results in tables/charts on the canvas, and helping users explore their data.

## Multi-Panel Canvas

The json-render spec supports multiple elements via its `elements` map + `children` arrays. The Data Architect doesn't need this because its forms are mutually exclusive (you define one thing at a time). The Data Analyst needs to show SQL + results + chart simultaneously.

A single `buildAnalystCanvasSpec(state)` function takes the full analyst state and deterministically builds a spec with all visible panels:

```
┌─────────────────────────────┐
│  SQL Editor (CodeMirror)    │  <- always visible once a query exists
│  SELECT country, COUNT(*)   │
│  FROM iceberg.ingest.events │
│  GROUP BY country           │
├─────────────────────────────┤
│  Query Stats                │  <- visible after query runs
│  1,234 rows · 0.42s        │
├─────────────────────────────┤
│  Results Table              │  <- visible after query runs
│  country | count            │
│  US      | 523              │
│  ...                        │
├─────────────────────────────┤
│  Bar Chart                  │  <- visible after agent renders chart
│  ████████ US (523)          │
│  █████   UK (312)           │
│  ███     DE (201)           │
└─────────────────────────────┘
```

### Spec structure

```typescript
{
  root: "layout",
  elements: {
    layout:  { type: "AnalystLayout", props: {}, children: ["sql", "stats", "results", "chart"] },
    sql:     { type: "SqlEditor", props: {} },
    stats:   { type: "QueryStats", props: {} },
    results: { type: "ResultsTable", props: {} },
    chart:   { type: "BarChart", props: {} },  // or LineChart, PieChart, ScatterPlot
  },
  state: {
    sql: "SELECT ...",
    columns: [...],
    rows: [...],
    queryStatus: "success",
    duration: "0.42s",
    rowCount: 1234,
    chart: { type: "bar", xColumn: "country", yColumn: "count" }
  }
}
```

Each tool reads the current canvas state, merges in its new data, and calls `buildAnalystCanvasSpec()` to produce the complete spec. Panels that don't have data yet are omitted from the `children` array. Same replacement model as Data Architect — no new canvas infrastructure needed.

## Tool Flow

`runQuery` is both an execution tool and a render tool. It runs the SQL, stores results, and returns a spec that shows the SQL editor + results table. The agent then calls `renderChart` to add a visualization.

```
User: "What's the distribution of events by country?"
  |
  v
getSkill("exploring-data")
  |
  v
listTables / describeTable      <- agent learns what data is available
  |
  v
renderSqlEditor(sql)            <- canvas shows editable SQL editor
  |                                user can edit before running
  v
runQuery()                      <- executes SQL from canvas, shows results table
  |                                returns sample rows to agent for reasoning
  v
renderChart({type:"bar", ...})  <- adds chart to canvas
  |
  v
User: "show as line chart"      -> renderChart({type:"line", ...})
```

## Tools

| Tool | Purpose | Canvas Effect |
|------|---------|---------------|
| `getSkill` | Load skill workflow doc | None |
| `listTables` | Browse catalogs/schemas/tables via Trino | None (returns list to agent) |
| `describeTable` | Get column names, types, partition info | None (returns schema to agent) |
| `renderSqlEditor` | Show editable SQL on canvas | Canvas: SQL editor panel |
| `runQuery` | Execute SQL, return + store results | Canvas: SQL editor + results table |
| `renderChart` | Configure chart visualization | Canvas: SQL editor + results table + chart |
| `readCanvasState` | Read current canvas state | None |
| `listDefinitions` | List merged Data Architect definitions | None (context for suggestions) |
| `getDefinition` | Get specific definition | None (context for suggestions) |
| `handback` | Return control to concierge | None |

## Canvas Components

Built with `@json-render/react` registry + Recharts for charts.

| Component | Description |
|-----------|-------------|
| `AnalystLayout` | Root layout container, renders children vertically with gaps |
| `SqlEditor` | CodeMirror with SQL syntax highlighting, editable by user |
| `QueryStats` | Badge showing row count, duration, query ID |
| `ResultsTable` | Paginated data table for query results (column headers + rows) |
| `BarChart` | Bar chart (vertical/horizontal) via Recharts |
| `LineChart` | Line/area chart with optional multi-series via Recharts |
| `PieChart` | Pie/donut chart via Recharts |
| `ScatterPlot` | Scatter plot via Recharts |
| `ChartContainer` | Wrapper with title, description, download actions |

## File Structure

```
extensions/data-analyst/
├── agent.ts                      # ToolLoopAgent, instructions, tool registry
├── register.ts                   # registerExtension("data-analyst")
├── spec-builder.ts               # buildAnalystCanvasSpec(state) — single deterministic builder
├── canvas/
│   ├── data-analyst-canvas.tsx   # Root canvas component (JSONUIProvider + Renderer)
│   ├── catalog.ts                # json-render catalog definition
│   └── registry.tsx              # React component registry
├── skills/
│   ├── index.ts                  # Skill metadata + loader
│   └── exploring-data.md         # Workflow: browse -> query -> visualize
├── tools/
│   ├── index.ts                  # Tool exports
│   ├── get-skill.ts              # Load skill markdown
│   ├── list-tables.ts            # SHOW SCHEMAS / SHOW TABLES via Trino
│   ├── describe-table.ts         # DESCRIBE table via Trino
│   ├── run-query.ts              # Execute SQL + render results on canvas
│   ├── render-sql-editor.ts      # Render editable SQL on canvas (before running)
│   ├── render-chart.ts           # Add chart visualization to canvas
│   └── read-canvas-state.ts      # Read current canvas state
└── lib/
    └── trino-client.ts           # Trino REST API client (read-only, row limit, timeout)
```

## Integration Points (existing files to modify)

| File | Change |
|------|--------|
| `src/extensions/index.ts` | Add `import "./data-analyst/register"` |
| `src/extensions/canvases.ts` | Add `"data-analyst": DataAnalystCanvas` |
| `src/components/chat/chat-panel.tsx` | Broaden tool detection pattern (see below) |
| `apps/web/package.json` | Add `recharts` dependency |

### Chat panel tool detection

The current detection in `chat-panel.tsx` checks `startsWith("tool-render") && endsWith("Form")`. Broaden to:

```typescript
const isCanvasToolPart =
  part.type.startsWith("tool-render") ||    // covers render*Form + renderSqlEditor/Chart/ResultsTable
  part.type === "tool-generateYaml" ||       // Data Architect YAML
  part.type === "tool-runQuery";             // Data Analyst query execution
```

Backwards-compatible — all existing Data Architect tools still match.

## Trino Client

New server-side HTTP client at `lib/trino-client.ts`:

- Hits Trino REST API at `TRINO_URL` (default `http://localhost:8080`)
- `executeQuery(sql): { columns, rows, queryId, stats }`
- Read-only enforcement — rejects DDL/DML (only `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`)
- Row limit safeguard (default 10,000 rows)
- Query timeout (default 30s)

### New env variable

- `TRINO_URL` — Trino HTTP endpoint (default: `http://localhost:8080`)

## Safety

- Read-only SQL enforcement at the Trino client level (parse-before-execute)
- Row limits to prevent OOM on canvas (configurable, default 10k)
- Query timeout (30s default)
- No `DROP`, `DELETE`, `INSERT`, `ALTER`, `CREATE` — analyst reads, architect writes

## Reuse vs. Build New

| Reuse from Data Architect | Build New |
|--------------------------|-----------|
| Extension registration pattern | Trino HTTP client |
| `ToolLoopAgent` + handback protocol | SQL execution tools |
| Skill loading pattern | Chart components (Recharts) |
| Canvas persistence (canvasState in DB) | ResultsTable component |
| `readCanvasState` pattern | SqlEditor component |
| json-render catalog/registry pattern | Chart rendering tools |
| Chat panel tool detection (broadened) | Multi-panel spec builder |
| `listDefinitions` / `getDefinition` tools | Query safety layer |

## Implementation Order

1. Trino client (`lib/trino-client.ts`)
2. Spec builder (`spec-builder.ts`)
3. Tools — getSkill, listTables, describeTable, renderSqlEditor, runQuery, renderChart, readCanvasState
4. Agent (`agent.ts`) — instructions + tool wiring
5. Canvas components — SqlEditor, ResultsTable, QueryStats, chart components, AnalystLayout
6. Catalog + registry — json-render component definitions
7. Canvas root (`data-analyst-canvas.tsx`)
8. Registration — register.ts + canvases.ts + index.ts
9. Chat panel fix — broaden tool detection
10. Skill doc — `exploring-data.md`
