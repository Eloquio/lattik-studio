import type { Spec } from "@json-render/core";
import { z } from "zod";

// Shared zod schemas the form-builders depend on. Inlined here rather than
// imported from the agent-service's data-architect lib — the adapter is its
// own package and shouldn't reach across into agent-service's source. If
// this duplication grows, lift to a future `packages/lattik-types`.

const columnTypeSchema = z.enum([
  "string",
  "int32",
  "int64",
  "float",
  "double",
  "boolean",
  "timestamp",
  "date",
  "bytes",
  "json",
]);

const classificationSchema = z.object({
  pii: z.boolean().optional(),
  phi: z.boolean().optional(),
  financial: z.boolean().optional(),
  credentials: z.boolean().optional(),
});

/**
 * Per-kind form spec builders.
 *
 * The Data Architect agent used to render forms by free-form generating JSONL
 * spec patches inside a `spec` code fence. That worked but exposed a class of
 * LLM-generation bugs (token-level array repetition loops, missing fields,
 * malformed structure) every time the agent rendered a form. The renderForm
 * tool replaces that pattern: the agent calls the tool with structured initial
 * state, and the canonical Spec is built deterministically from one of the
 * functions in this file. The LLM never produces raw spec patches.
 *
 * Each builder takes initial state matching its form's canvas state shape and
 * returns a complete json-render Spec ready to be applied to the canvas.
 * Defaults match the form components' fallback values exactly so the rendered
 * UI looks the same whether the LLM populates a field or leaves it blank.
 */

// ---- Initial state schemas (one per kind) ----
//
// These mirror the canvas form state shapes in canvas/registry.tsx — every
// field maps to a `store.set("/...")` call inside the corresponding form
// component. They are intentionally permissive (almost everything optional)
// so the LLM can pre-populate whatever it can glean from the conversation
// and leave the rest for the user to fill in directly.

export const entityFormInitialStateSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("snake_case entity identifier, e.g. 'user'"),
  description: z
    .string()
    .optional()
    .describe("Business description (10-500 chars)"),
  id_field: z
    .string()
    .optional()
    .describe("Identifier column name, must end with '_id', e.g. 'user_id'"),
  id_type: z
    .enum(["int64", "string"])
    .optional()
    .describe("Type of the ID field"),
});

export const dimensionFormInitialStateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  entity: z
    .string()
    .optional()
    .describe("Name of the entity this dimension belongs to"),
  source_table: z.string().optional(),
  source_column: z.string().optional(),
  data_type: columnTypeSchema.optional(),
});

const loggerColumnInitialStateSchema = z
  .object({
    name: z.string().describe("Column name (snake_case)"),
    type: columnTypeSchema.describe("Column data type"),
    dimension: z
      .string()
      .optional()
      .describe("Optional dimension link, e.g. 'user_id'"),
    description: z.string().optional(),
    classification: classificationSchema
      .optional()
      .describe(
        "Sensitivity classification. Set any of { pii, phi, financial, credentials } to true to mark the column; downstream tooling keys off these flags for masking and access control."
      ),
  })
  .describe("A user-defined column on a logger table");

export const loggerTableFormInitialStateSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Qualified name in 'schema.table_name' format"),
  description: z.string().optional(),
  retention: z
    .string()
    .optional()
    .describe("Retention period, e.g. '30d'. Defaults to '30d' if omitted."),
  dedup_window: z
    .string()
    .optional()
    .describe("Dedup window, e.g. '1h'. Defaults to '1h' if omitted."),
  user_columns: z
    .array(loggerColumnInitialStateSchema)
    .max(50)
    .optional()
    .describe("User-defined columns. Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them here."),
});

const primaryKeyInitialStateSchema = z.object({
  column: z.string().describe("Primary key column name"),
  entity: z.string().describe("Entity this column references"),
});

const lifetimeWindowColumnInitialStateSchema = z.object({
  name: z.string(),
  strategy: z.literal("lifetime_window"),
  agg: z.string().describe("Aggregation expression, e.g. 'sum(amount)', 'count()'"),
});

const prependListColumnInitialStateSchema = z.object({
  name: z.string(),
  strategy: z.literal("prepend_list"),
  expr: z.string().describe("Expression for the value to collect, e.g. 'country'"),
  max_length: z.number().int().positive().describe("Max list length"),
});

const bitmapActivityColumnInitialStateSchema = z.object({
  name: z.string(),
  strategy: z.literal("bitmap_activity"),
  granularity: z.enum(["day", "hour"]).describe("One bit per time slot"),
  window: z.number().int().positive().describe("Number of time slots to track"),
});

const familyColumnInitialStateSchema = z.discriminatedUnion("strategy", [
  lifetimeWindowColumnInitialStateSchema,
  prependListColumnInitialStateSchema,
  bitmapActivityColumnInitialStateSchema,
]);

const keyMappingInitialStateSchema = z.object({
  pk_column: z.string(),
  source_column: z.string(),
});

const columnFamilyInitialStateSchema = z.object({
  name: z.string().optional().describe("Family name. Auto-derived from source if omitted."),
  source: z.string().describe("Source table name"),
  key_mapping: z.array(keyMappingInitialStateSchema).optional(),
  columns: z.array(familyColumnInitialStateSchema).max(50),
});

const derivedColumnInitialStateSchema = z.object({
  name: z.string(),
  expr: z.string(),
});

const backfillPlanInitialStateSchema = z.object({
  lookback: z
    .string()
    .optional()
    .describe("Backfill lookback window, e.g. '30d'. Defaults to '30d' if omitted."),
  parallelism: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How many ds values the backfill driver may process in parallel. Defaults to 1."),
});

export const lattikTableFormInitialStateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  retention: z.string().optional(),
  primary_key: z.array(primaryKeyInitialStateSchema).max(20).optional(),
  column_families: z.array(columnFamilyInitialStateSchema).max(20).optional(),
  derived_columns: z.array(derivedColumnInitialStateSchema).max(20).optional(),
  backfill: backfillPlanInitialStateSchema.optional(),
});

const calculationInitialStateSchema = z.object({
  expression: z.string(),
  source_table: z.string(),
});

export const metricFormInitialStateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  calculations: z.array(calculationInitialStateSchema).max(20).optional(),
});

// ---- Builders ----
//
// Each builder takes a parsed initial state object and returns a complete
// Spec. They generate `_key` fields for array entries (the form components
// use these as React keys) and apply the same field defaults as the form
// components themselves so the rendered UI is consistent regardless of which
// fields the LLM provided.

let _keyCounter = 0;
function nextKey(prefix: string): string {
  _keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_keyCounter}`;
}

function withKeys<T extends object>(
  prefix: string,
  items: ReadonlyArray<T> | undefined
): Array<T & { _key: string }> {
  return (items ?? []).map((item) => ({ ...item, _key: nextKey(prefix) }));
}

export function buildEntityFormSpec(
  s: z.infer<typeof entityFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "EntityForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      id_field: s.id_field ?? "",
      id_type: s.id_type ?? "string",
    },
  };
}

export function buildDimensionFormSpec(
  s: z.infer<typeof dimensionFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "DimensionForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      entity: s.entity ?? "",
      source_table: s.source_table ?? "",
      source_column: s.source_column ?? "",
      data_type: s.data_type ?? "string",
    },
  };
}

export function buildLoggerTableFormSpec(
  s: z.infer<typeof loggerTableFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "LoggerTableForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      retention: s.retention ?? "30d",
      dedup_window: s.dedup_window ?? "1h",
      user_columns: withKeys("col", s.user_columns),
    },
  };
}

export function buildLattikTableFormSpec(
  s: z.infer<typeof lattikTableFormInitialStateSchema>
): Spec {
  // Tag column families and their nested arrays with stable React keys.
  // Derive family name from source if not provided (e.g., "ingest.signups" → "signups").
  const columnFamilies = (s.column_families ?? []).map((cf) => ({
    _key: nextKey("cf"),
    name: cf.name || cf.source.split(".").pop() || cf.source,
    source: cf.source,
    key_mapping: withKeys("km", cf.key_mapping),
    columns: withKeys("fcol", cf.columns),
  }));

  return {
    root: "main",
    elements: {
      main: { type: "LattikTableForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      retention: s.retention ?? "30d",
      primary_key: withKeys("pk", s.primary_key),
      column_families: columnFamilies,
      derived_columns: withKeys("dc", s.derived_columns),
      backfill: {
        lookback: s.backfill?.lookback ?? "30d",
        parallelism: s.backfill?.parallelism ?? 1,
      },
    },
  };
}

export function buildMetricFormSpec(
  s: z.infer<typeof metricFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "MetricForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      calculations: withKeys("calc", s.calculations),
    },
  };
}
