/**
 * Intent actions — typed events a chat client emits when the user
 * interacts with a rendered intent. Carried as a `data-intent-action`
 * part on a user UIMessage; agents reason about the structured payload
 * directly rather than parsing free-form text.
 *
 * The action vocabulary is **per-intent-kind**: each render-intent
 * declares the actions it can emit. Adding a new variant to an
 * existing intent's action union is additive (agents that don't
 * recognize it ignore it). Renaming or restructuring requires versioning
 * the parent intent.
 *
 * By convention every action is paired with a human-readable text
 * summary in the same UIMessage (separate `text` part), so the chat
 * transcript stays readable when reviewed by a human. The action
 * payload is the source of truth for the agent.
 */

// ---------------------------------------------------------------------------
// Pipeline Manager
// ---------------------------------------------------------------------------

export type DagOverviewAction =
  /** User clicked a DAG row to drill in. */
  | { type: "select-row"; dagId: string }
  /** User clicked the "View runs" affordance — preferred over select-row
   * when the intent is unambiguous. */
  | { type: "view-runs"; dagId: string }
  /** User toggled the pause/unpause control on a row. */
  | { type: "toggle-pause"; dagId: string };

export type DagRunDetailAction =
  /** User clicked a task in the graph. */
  | { type: "select-task"; taskId: string }
  /** User asked for the logs of a specific task try. */
  | { type: "view-logs"; taskId: string; tryNumber?: number }
  /** User clicked "back to overview" or similar. */
  | { type: "dismiss" };

// ---------------------------------------------------------------------------
// Data Architect form actions — one shape across all five form kinds, since
// the form interactions are uniform. Specific form schemas constrain the
// `values` payload at validation time, not at the union level.
// ---------------------------------------------------------------------------

export type DefinitionFormAction =
  | { type: "submit"; values: Record<string, unknown> }
  | { type: "edit-field"; field: string; value: unknown }
  | { type: "cancel" };

export type DefinitionReviewAction =
  | { type: "approve" }
  | { type: "reject"; reason?: string };

export type YamlPreviewAction =
  /** User edited the YAML in the editor. The agent should use the new
   * content on the next submitPR call rather than the originally generated
   * spec. */
  | { type: "edit"; content: string; path: string }
  | { type: "submit-pr" }
  | { type: "discard" };

export type PrSubmittedAction =
  | { type: "open-pr" }
  | { type: "dismiss" };

// ---------------------------------------------------------------------------
// Data Analyst
// ---------------------------------------------------------------------------

export type SqlEditorAction =
  | { type: "edit"; sql: string }
  | { type: "run" };

export type QueryResultAction =
  | { type: "select-cell"; row: number; column: string }
  /** User asked to chart the result with the given configuration. */
  | { type: "chart"; chartType: string; xColumn: string; yColumns: string[] };

export type ChartAction =
  | { type: "change-type"; chartType: string }
  | { type: "change-axes"; xColumn: string; yColumns: string[] };

// ---------------------------------------------------------------------------
// Discriminated union over all (intentKind, surface, action) tuples.
// ---------------------------------------------------------------------------

export type IntentAction =
  | { intentKind: "dag-overview"; surface: "main"; action: DagOverviewAction }
  | { intentKind: "dag-run-detail"; surface: "detail"; action: DagRunDetailAction }
  | { intentKind: "entity-form"; surface: "form"; action: DefinitionFormAction }
  | { intentKind: "dimension-form"; surface: "form"; action: DefinitionFormAction }
  | { intentKind: "logger-table-form"; surface: "form"; action: DefinitionFormAction }
  | { intentKind: "lattik-table-form"; surface: "form"; action: DefinitionFormAction }
  | { intentKind: "metric-form"; surface: "form"; action: DefinitionFormAction }
  | { intentKind: "definition-review"; surface: "review"; action: DefinitionReviewAction }
  | { intentKind: "yaml-preview"; surface: "yaml"; action: YamlPreviewAction }
  | { intentKind: "pr-submitted"; surface: "pr-card"; action: PrSubmittedAction }
  | { intentKind: "sql-editor"; surface: "editor"; action: SqlEditorAction }
  | { intentKind: "query-result"; surface: "results"; action: QueryResultAction }
  | { intentKind: "chart"; surface: "chart"; action: ChartAction };
