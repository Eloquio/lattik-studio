/**
 * Render-intents — typed semantic instructions an agent emits to a chat
 * client. Each intent declares *what* to show, not *how*; the per-client
 * adapter (json-render for web, Block Kit for Slack, …) translates intent
 * to native UI.
 *
 * Two rules of thumb (codified in the plan doc, restated here for
 * readability at the source):
 *
 *   1. Render-intents carry data, not layout. A `dag-overview` is "the
 *      list of DAGs and their status," not "two columns with a status
 *      badge on the right."
 *   2. Render-intents and their data shapes are append-only. Adding a
 *      field is fine. Renaming or restructuring requires a versioned
 *      kind (e.g. `dag-overview-v2`).
 *
 * The `surface` field is static metadata per intent kind — the agent
 * never picks it. Web canvas uses `surface` to lay out multiple intents
 * in distinct named regions; simpler clients (Slack, Discord, CLI) can
 * treat it as a hint or ignore it entirely.
 */

// ---------------------------------------------------------------------------
// Pipeline Manager
// ---------------------------------------------------------------------------

export type DagRunState = "queued" | "running" | "success" | "failed";

export interface DagSummary {
  dagId: string;
  description: string | null;
  isPaused: boolean;
  isActive: boolean;
  /** Cron string, dataset spec, or null for unscheduled. */
  schedule: string | { value: string } | null;
  tags: string[];
  /** ISO timestamp of the next scheduled run, or null if paused/unscheduled. */
  nextRun: string | null;
  /** State of the most recent run, or null when the DAG has never run. */
  lastRunState: DagRunState | null;
  /** States of the last N runs in chronological order — drives the sparkline. */
  recentRunStates: DagRunState[];
}

export interface DagOverviewIntent {
  kind: "dag-overview";
  surface: "main";
  data: {
    dags: DagSummary[];
    totalEntries: number;
  };
}

export interface TaskInstanceSummary {
  taskId: string;
  state:
    | "success"
    | "running"
    | "failed"
    | "upstream_failed"
    | "skipped"
    | "up_for_retry"
    | "queued"
    | "scheduled"
    | "deferred"
    | "removed"
    | null;
  operator: string | null;
  startDate: string | null;
  endDate: string | null;
  durationSeconds: number | null;
  tryNumber: number;
  maxTries: number;
}

export interface DagRunDetailIntent {
  kind: "dag-run-detail";
  surface: "detail";
  data: {
    dagId: string;
    runId: string;
    /** Logical run date (Airflow's `logical_date`), or null when unknown. */
    logicalDate: string | null;
    /** Run-level state. Same vocabulary as DagRunState plus null for
     * "agent couldn't fetch run metadata." */
    runState: DagRunState | null;
    /** ISO timestamps; null when the run hasn't started / finished yet. */
    startDate: string | null;
    endDate: string | null;
    tasks: TaskInstanceSummary[];
  };
}

// ---------------------------------------------------------------------------
// Data Architect — placeholders until the per-form data shapes are nailed
// down during their tool migrations. Each placeholder is a structurally-typed
// stub so the discriminated union compiles end-to-end; the `data` shapes get
// pinned down when the matching render tool is actually ported.
// ---------------------------------------------------------------------------

export interface EntityFormIntent {
  kind: "entity-form";
  surface: "form";
  data: { initialState: Record<string, unknown> };
}

export interface DimensionFormIntent {
  kind: "dimension-form";
  surface: "form";
  data: { initialState: Record<string, unknown> };
}

export interface LoggerTableFormIntent {
  kind: "logger-table-form";
  surface: "form";
  data: { initialState: Record<string, unknown> };
}

export interface LattikTableFormIntent {
  kind: "lattik-table-form";
  surface: "form";
  data: { initialState: Record<string, unknown> };
}

export interface MetricFormIntent {
  kind: "metric-form";
  surface: "form";
  data: { initialState: Record<string, unknown> };
}

export interface DefinitionReviewIntent {
  kind: "definition-review";
  surface: "review";
  data: {
    definitionKind: string;
    name: string;
    before: unknown;
    after: unknown;
  };
}

export interface YamlPreviewIntent {
  kind: "yaml-preview";
  surface: "yaml";
  data: {
    definitionKind: string;
    name: string;
    files: { path: string; content: string }[];
  };
}

export interface PrSubmittedIntent {
  kind: "pr-submitted";
  surface: "pr-card";
  data: {
    definitionKind: string;
    name: string;
    prNumber: number;
    prUrl: string;
    branch: string;
    files: string[];
  };
}

// ---------------------------------------------------------------------------
// Data Analyst — placeholders, same rationale.
// ---------------------------------------------------------------------------

export interface SqlEditorIntent {
  kind: "sql-editor";
  surface: "editor";
  data: { sql: string };
}

export interface QueryResultColumn {
  name: string;
  type: string;
}

export interface QueryResultIntent {
  kind: "query-result";
  surface: "results";
  data: {
    columns: QueryResultColumn[];
    /** Inline rows when small; clients that need pagination can request more
     * via an action. */
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
    durationMs: number;
  };
}

export interface ChartIntent {
  kind: "chart";
  surface: "chart";
  data: {
    chartType: "bar" | "line" | "area" | "pie" | "scatter";
    xColumn: string;
    yColumns: string[];
    title?: string;
  };
}

// ---------------------------------------------------------------------------
// Discriminated union over all render-intents.
// ---------------------------------------------------------------------------

export type RenderIntent =
  | DagOverviewIntent
  | DagRunDetailIntent
  | EntityFormIntent
  | DimensionFormIntent
  | LoggerTableFormIntent
  | LattikTableFormIntent
  | MetricFormIntent
  | DefinitionReviewIntent
  | YamlPreviewIntent
  | PrSubmittedIntent
  | SqlEditorIntent
  | QueryResultIntent
  | ChartIntent;

export type RenderIntentKind = RenderIntent["kind"];

/** Type-guard helper for adapters: narrow a RenderIntent to a specific kind. */
export function isIntent<K extends RenderIntentKind>(
  intent: RenderIntent,
  kind: K,
): intent is Extract<RenderIntent, { kind: K }> {
  return intent.kind === kind;
}
