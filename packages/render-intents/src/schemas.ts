/**
 * Runtime zod validators paired with the TS types in `intents.ts` and
 * `actions.ts`. Use these at the adapter boundary when you need to verify
 * an inbound intent / action came from a trusted producer in the right
 * shape (e.g. validating a `data-intent-action` part on a UIMessage
 * before passing it to the agent's tool loop).
 *
 * Within agent-service the TS types are sufficient — the render tools
 * return a typed value, the AI SDK serializes it, the adapter receives
 * structurally-correct shapes. Zod parsing is overkill on the happy path
 * but valuable at the trust boundary.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const dagRunStateSchema = z.enum(["queued", "running", "success", "failed"]);

const dagSummarySchema = z.object({
  dagId: z.string(),
  description: z.string().nullable(),
  isPaused: z.boolean(),
  isActive: z.boolean(),
  schedule: z.union([z.string(), z.object({ value: z.string() }), z.null()]),
  tags: z.array(z.string()),
  nextRun: z.string().nullable(),
  lastRunState: dagRunStateSchema.nullable(),
  recentRunStates: z.array(dagRunStateSchema),
});

const taskInstanceStateSchema = z
  .enum([
    "success",
    "running",
    "failed",
    "upstream_failed",
    "skipped",
    "up_for_retry",
    "queued",
    "scheduled",
    "deferred",
    "removed",
  ])
  .nullable();

const taskInstanceSummarySchema = z.object({
  taskId: z.string(),
  state: taskInstanceStateSchema,
  operator: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  tryNumber: z.number(),
  maxTries: z.number(),
});

const queryResultColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
});

// ---------------------------------------------------------------------------
// Intent schemas
// ---------------------------------------------------------------------------

const dagOverviewIntentSchema = z.object({
  kind: z.literal("dag-overview"),
  surface: z.literal("main"),
  data: z.object({
    dags: z.array(dagSummarySchema),
    totalEntries: z.number(),
  }),
});

const dagRunDetailIntentSchema = z.object({
  kind: z.literal("dag-run-detail"),
  surface: z.literal("detail"),
  data: z.object({
    dagId: z.string(),
    runId: z.string(),
    logicalDate: z.string().nullable(),
    runState: dagRunStateSchema.nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    tasks: z.array(taskInstanceSummarySchema),
  }),
});

const formInitialStateSchema = z.object({
  initialState: z.record(z.string(), z.unknown()),
});

const entityFormIntentSchema = z.object({
  kind: z.literal("entity-form"),
  surface: z.literal("form"),
  data: formInitialStateSchema,
});
const dimensionFormIntentSchema = z.object({
  kind: z.literal("dimension-form"),
  surface: z.literal("form"),
  data: formInitialStateSchema,
});
const loggerTableFormIntentSchema = z.object({
  kind: z.literal("logger-table-form"),
  surface: z.literal("form"),
  data: formInitialStateSchema,
});
const lattikTableFormIntentSchema = z.object({
  kind: z.literal("lattik-table-form"),
  surface: z.literal("form"),
  data: formInitialStateSchema,
});
const metricFormIntentSchema = z.object({
  kind: z.literal("metric-form"),
  surface: z.literal("form"),
  data: formInitialStateSchema,
});

const definitionReviewIntentSchema = z.object({
  kind: z.literal("definition-review"),
  surface: z.literal("review"),
  data: z.object({
    definitionKind: z.string(),
    name: z.string(),
    before: z.unknown(),
    after: z.unknown(),
  }),
});

const yamlPreviewIntentSchema = z.object({
  kind: z.literal("yaml-preview"),
  surface: z.literal("yaml"),
  data: z.object({
    definitionKind: z.string(),
    name: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
});

const prSubmittedIntentSchema = z.object({
  kind: z.literal("pr-submitted"),
  surface: z.literal("pr-card"),
  data: z.object({
    definitionKind: z.string(),
    name: z.string(),
    prNumber: z.number(),
    prUrl: z.string(),
    branch: z.string(),
    files: z.array(z.string()),
  }),
});

const sqlEditorIntentSchema = z.object({
  kind: z.literal("sql-editor"),
  surface: z.literal("editor"),
  data: z.object({ sql: z.string() }),
});

const queryResultIntentSchema = z.object({
  kind: z.literal("query-result"),
  surface: z.literal("results"),
  data: z.object({
    columns: z.array(queryResultColumnSchema),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number(),
    truncated: z.boolean(),
    durationMs: z.number(),
  }),
});

const chartIntentSchema = z.object({
  kind: z.literal("chart"),
  surface: z.literal("chart"),
  data: z.object({
    chartType: z.enum(["bar", "line", "area", "pie", "scatter"]),
    xColumn: z.string(),
    yColumns: z.array(z.string()),
    title: z.string().optional(),
  }),
});

export const renderIntentSchema = z.discriminatedUnion("kind", [
  dagOverviewIntentSchema,
  dagRunDetailIntentSchema,
  entityFormIntentSchema,
  dimensionFormIntentSchema,
  loggerTableFormIntentSchema,
  lattikTableFormIntentSchema,
  metricFormIntentSchema,
  definitionReviewIntentSchema,
  yamlPreviewIntentSchema,
  prSubmittedIntentSchema,
  sqlEditorIntentSchema,
  queryResultIntentSchema,
  chartIntentSchema,
]);

// ---------------------------------------------------------------------------
// Action schemas
// ---------------------------------------------------------------------------

const dagOverviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select-row"), dagId: z.string() }),
  z.object({ type: z.literal("view-runs"), dagId: z.string() }),
  z.object({ type: z.literal("toggle-pause"), dagId: z.string() }),
]);

const dagRunDetailActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select-task"), taskId: z.string() }),
  z.object({
    type: z.literal("view-logs"),
    taskId: z.string(),
    tryNumber: z.number().optional(),
  }),
  z.object({ type: z.literal("dismiss") }),
]);

const definitionFormActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submit"), values: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("edit-field"), field: z.string(), value: z.unknown() }),
  z.object({ type: z.literal("cancel") }),
]);

const definitionReviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("reject"), reason: z.string().optional() }),
]);

const yamlPreviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("edit"), content: z.string(), path: z.string() }),
  z.object({ type: z.literal("submit-pr") }),
  z.object({ type: z.literal("discard") }),
]);

const prSubmittedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open-pr") }),
  z.object({ type: z.literal("dismiss") }),
]);

const sqlEditorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("edit"), sql: z.string() }),
  z.object({ type: z.literal("run") }),
]);

const queryResultActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select-cell"), row: z.number(), column: z.string() }),
  z.object({
    type: z.literal("chart"),
    chartType: z.string(),
    xColumn: z.string(),
    yColumns: z.array(z.string()),
  }),
]);

const chartActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("change-type"), chartType: z.string() }),
  z.object({
    type: z.literal("change-axes"),
    xColumn: z.string(),
    yColumns: z.array(z.string()),
  }),
]);

export const intentActionSchema = z.discriminatedUnion("intentKind", [
  z.object({
    intentKind: z.literal("dag-overview"),
    surface: z.literal("main"),
    action: dagOverviewActionSchema,
  }),
  z.object({
    intentKind: z.literal("dag-run-detail"),
    surface: z.literal("detail"),
    action: dagRunDetailActionSchema,
  }),
  z.object({
    intentKind: z.literal("entity-form"),
    surface: z.literal("form"),
    action: definitionFormActionSchema,
  }),
  z.object({
    intentKind: z.literal("dimension-form"),
    surface: z.literal("form"),
    action: definitionFormActionSchema,
  }),
  z.object({
    intentKind: z.literal("logger-table-form"),
    surface: z.literal("form"),
    action: definitionFormActionSchema,
  }),
  z.object({
    intentKind: z.literal("lattik-table-form"),
    surface: z.literal("form"),
    action: definitionFormActionSchema,
  }),
  z.object({
    intentKind: z.literal("metric-form"),
    surface: z.literal("form"),
    action: definitionFormActionSchema,
  }),
  z.object({
    intentKind: z.literal("definition-review"),
    surface: z.literal("review"),
    action: definitionReviewActionSchema,
  }),
  z.object({
    intentKind: z.literal("yaml-preview"),
    surface: z.literal("yaml"),
    action: yamlPreviewActionSchema,
  }),
  z.object({
    intentKind: z.literal("pr-submitted"),
    surface: z.literal("pr-card"),
    action: prSubmittedActionSchema,
  }),
  z.object({
    intentKind: z.literal("sql-editor"),
    surface: z.literal("editor"),
    action: sqlEditorActionSchema,
  }),
  z.object({
    intentKind: z.literal("query-result"),
    surface: z.literal("results"),
    action: queryResultActionSchema,
  }),
  z.object({
    intentKind: z.literal("chart"),
    surface: z.literal("chart"),
    action: chartActionSchema,
  }),
]);
