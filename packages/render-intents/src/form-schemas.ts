import { z } from "zod";

/**
 * Per-kind form `initialState` schemas. These describe the validated
 * payload shape carried inside a form intent's `data.initialState`.
 *
 * They live in `render-intents` (the protocol package) so:
 * - the JSON-render adapter can validate intents at the trust boundary
 *   before composing a json-render Spec, and
 * - the agent-service can use the same schemas as the *tool input
 *   schema* for its render-form tools, so the LLM sees the exact
 *   accepted shape (key names, value enums) and the AI SDK rejects
 *   shape-mismatched tool calls before execution.
 *
 * Keep these in lockstep with the form components in
 * `apps/web/src/extensions/data-architect/canvas/registry.tsx`. Field
 * names here map 1:1 to `store.set("/...")` calls in the form
 * components — adding a new field anywhere requires a matching change
 * in the other.
 */

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

// Every nested object schema below is `.strict()` for the same reason
// as the top-level form schemas: silent key-stripping inside an array
// element (e.g. a column where the LLM names the field `kind` instead
// of `type`) would let the AI SDK accept the call, the canvas would
// render with the field defaulted, and no error would surface. Strict
// at every nesting level closes that hole.

const classificationSchema = z
  .object({
    pii: z.boolean().optional(),
    phi: z.boolean().optional(),
    financial: z.boolean().optional(),
    credentials: z.boolean().optional(),
  })
  .strict();

// `.strict()` on every top-level form schema: if the LLM hands us an
// unknown key (e.g. `columns` instead of `user_columns`, or `dedup`
// instead of `dedup_window`), zod throws rather than silently stripping
// — that error propagates to the AI SDK, the tool call fails, the loop
// reports the error back to the model, and the model self-corrects on
// the next turn. Without strict mode, the wrong key would be dropped
// quietly and the canvas would render an empty form (the regression we
// shipped this slice to fix).

export const entityFormInitialStateSchema = z
  .object({
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
  })
  .strict();

export const dimensionFormInitialStateSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    entity: z
      .string()
      .optional()
      .describe("Name of the entity this dimension belongs to"),
    source_table: z.string().optional(),
    source_column: z.string().optional(),
    data_type: columnTypeSchema.optional(),
  })
  .strict();

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
        "Sensitivity classification. Set any of { pii, phi, financial, credentials } to true to mark the column; downstream tooling keys off these flags for masking and access control.",
      ),
  })
  .strict()
  .describe("A user-defined column on a logger table");

// Agent-input variant of the logger column schema: same shape as the
// canonical, MINUS the `dimension` field. Dimension binding links a
// column to a Dimension definition in the workspace; that's a user
// action via the canvas UI (with a dropdown of definitions that
// actually exist). Letting the agent set `dimension` from the LLM side
// produced invalid bindings — the agent invented dimensions like
// "user_id" that didn't exist in the workspace, the canvas rendered
// the chip anyway, and downstream tooling (static check, reviewer)
// flagged the broken reference. Removing the field from the agent's
// view cuts that whole class of bug at the source.
//
// The canonical `loggerColumnInitialStateSchema` (with dimension)
// stays for the adapter side: when the user has bound a dimension via
// the canvas UI and the spec round-trips through safeFormSpec, the
// canonical schema parses it without stripping.
export const loggerColumnAgentInputSchema = loggerColumnInitialStateSchema
  .omit({ dimension: true })
  .strict()
  .describe(
    "A user-defined column on a logger table (agent input). The `dimension` field is intentionally omitted — column-to-dimension bindings are set by the user via the canvas UI, not by the agent.",
  );

export const loggerTableFormInitialStateSchema = z
  .object({
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
      .describe(
        "Dedup window, e.g. '1h'. Defaults to '1h' if omitted. The field is named `dedup_window` — NOT `dedup`.",
      ),
    user_columns: z
      .array(loggerColumnInitialStateSchema)
      .max(50)
      .optional()
      .describe(
        "User-defined columns under the EXACT key name `user_columns`. Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them here.",
      ),
  })
  .strict();

// Agent-facing version of the form schema. Identical to the canonical
// except `user_columns` items use the agent-input column schema (no
// `dimension` field). The agent-loop's TOOL_DEFINITIONS and the
// renderLoggerTableFormTool both wire this in as the input schema, so
// the LLM's JSON-schema view doesn't surface `dimension` and strict
// mode rejects it if the agent tries to set one.
export const loggerTableFormAgentInputSchema = loggerTableFormInitialStateSchema
  .extend({
    user_columns: z
      .array(loggerColumnAgentInputSchema)
      .max(50)
      .optional()
      .describe(
        "User-defined columns. Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them here. Column-to-dimension bindings are set by the user via the canvas UI; you do NOT pass `dimension` on column items.",
      ),
  })
  .strict();

const primaryKeyInitialStateSchema = z
  .object({
    column: z.string().describe("Primary key column name"),
    entity: z.string().describe("Entity this column references"),
  })
  .strict();

const lifetimeWindowColumnInitialStateSchema = z
  .object({
    name: z.string(),
    strategy: z.literal("lifetime_window"),
    agg: z
      .string()
      .describe("Aggregation expression, e.g. 'sum(amount)', 'count()'"),
  })
  .strict();

const prependListColumnInitialStateSchema = z
  .object({
    name: z.string(),
    strategy: z.literal("prepend_list"),
    expr: z
      .string()
      .describe("Expression for the value to collect, e.g. 'country'"),
    max_length: z.number().int().positive().describe("Max list length"),
  })
  .strict();

const bitmapActivityColumnInitialStateSchema = z
  .object({
    name: z.string(),
    strategy: z.literal("bitmap_activity"),
    granularity: z.enum(["day", "hour"]).describe("One bit per time slot"),
    window: z
      .number()
      .int()
      .positive()
      .describe("Number of time slots to track"),
  })
  .strict();

const familyColumnInitialStateSchema = z.discriminatedUnion("strategy", [
  lifetimeWindowColumnInitialStateSchema,
  prependListColumnInitialStateSchema,
  bitmapActivityColumnInitialStateSchema,
]);

const keyMappingInitialStateSchema = z
  .object({
    pk_column: z.string(),
    source_column: z.string(),
  })
  .strict();

const columnFamilyInitialStateSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe("Family name. Auto-derived from source if omitted."),
    source: z.string().describe("Source table name"),
    key_mapping: z.array(keyMappingInitialStateSchema).optional(),
    columns: z.array(familyColumnInitialStateSchema).max(50),
  })
  .strict();

const derivedColumnInitialStateSchema = z
  .object({
    name: z.string(),
    expr: z.string(),
  })
  .strict();

const backfillPlanInitialStateSchema = z
  .object({
    lookback: z
      .string()
      .optional()
      .describe(
        "Backfill lookback window, e.g. '30d'. Defaults to '30d' if omitted.",
      ),
    parallelism: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How many ds values the backfill driver may process in parallel. Defaults to 1.",
      ),
  })
  .strict();

export const lattikTableFormInitialStateSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    retention: z.string().optional(),
    primary_key: z.array(primaryKeyInitialStateSchema).max(20).optional(),
    column_families: z
      .array(columnFamilyInitialStateSchema)
      .max(20)
      .optional(),
    derived_columns: z
      .array(derivedColumnInitialStateSchema)
      .max(20)
      .optional(),
    backfill: backfillPlanInitialStateSchema.optional(),
  })
  .strict();

const calculationInitialStateSchema = z
  .object({
    expression: z.string(),
    source_table: z.string(),
  })
  .strict();

export const metricFormInitialStateSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    calculations: z.array(calculationInitialStateSchema).max(20).optional(),
  })
  .strict();
