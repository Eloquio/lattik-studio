import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  type EntityFormIntent,
  type DimensionFormIntent,
  type LoggerTableFormIntent,
  type LattikTableFormIntent,
  type MetricFormIntent,
  entityFormInitialStateSchema,
  dimensionFormInitialStateSchema,
  loggerTableFormAgentInputSchema,
  lattikTableFormInitialStateSchema,
  metricFormInitialStateSchema,
} from "@eloquio/render-intents";

/**
 * The five Data Architect form-render tools, ported to typed
 * render-intents. Each emits its kind-matching intent on the
 * `form` surface; the json-render-adapter handles the actual
 * Spec composition (with per-kind initial-state schema validation
 * as the trust boundary).
 *
 * Each tool's input schema is the *exact* per-kind initialState
 * schema from `@eloquio/render-intents`. That way the LLM sees the
 * accepted field names + value enums via JSON schema, and the AI SDK
 * rejects shape-mismatched tool calls before execution. Previously
 * we used a loose `Record<string, unknown>` and validated only on
 * the adapter side — when validation failed the canvas silently
 * fell back to an empty form. Strict input schemas catch the bug
 * up-front and let the model self-correct on the next iteration.
 */

function makeInputSchema<S extends z.ZodTypeAny>(initialStateSchema: S) {
  return zodSchema(
    z.object({
      initialState: initialStateSchema
        .optional()
        .describe(
          "Partial form state to pre-fill. Pass any fields you can glean from the user's request — every field is optional. The user fills in the rest.",
        ),
    }),
  );
}

export const renderEntityFormTool = tool({
  description:
    "Render the Entity definition form on the canvas. Pre-fill via initialState (name, description, id_field, id_type).",
  inputSchema: makeInputSchema(entityFormInitialStateSchema),
  execute: async (input: {
    initialState?: z.infer<typeof entityFormInitialStateSchema>;
  }): Promise<EntityFormIntent> => ({
    kind: "entity-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderDimensionFormTool = tool({
  description:
    "Render the Dimension definition form on the canvas. Pre-fill via initialState (name, description, entity, source_table, source_column, data_type).",
  inputSchema: makeInputSchema(dimensionFormInitialStateSchema),
  execute: async (input: {
    initialState?: z.infer<typeof dimensionFormInitialStateSchema>;
  }): Promise<DimensionFormIntent> => ({
    kind: "dimension-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderLoggerTableFormTool = tool({
  description:
    "Render the Logger Table definition form on the canvas. Pre-fill via initialState. The user-defined column list goes under the `user_columns` key (NOT `columns` or `customColumns`); each item is { name, type, description?, classification? }. Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them. Column-to-dimension bindings are set by the user via the canvas UI; do NOT pass `dimension` on column items.",
  inputSchema: makeInputSchema(loggerTableFormAgentInputSchema),
  execute: async (input: {
    initialState?: z.infer<typeof loggerTableFormAgentInputSchema>;
  }): Promise<LoggerTableFormIntent> => ({
    kind: "logger-table-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderLattikTableFormTool = tool({
  description:
    "Render the Lattik Table definition form on the canvas. Pre-fill via initialState (name, description, primary_key, column_families, derived_columns, backfill).",
  inputSchema: makeInputSchema(lattikTableFormInitialStateSchema),
  execute: async (input: {
    initialState?: z.infer<typeof lattikTableFormInitialStateSchema>;
  }): Promise<LattikTableFormIntent> => ({
    kind: "lattik-table-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderMetricFormTool = tool({
  description:
    "Render the Metric definition form on the canvas. Pre-fill via initialState (name, description, calculations).",
  inputSchema: makeInputSchema(metricFormInitialStateSchema),
  execute: async (input: {
    initialState?: z.infer<typeof metricFormInitialStateSchema>;
  }): Promise<MetricFormIntent> => ({
    kind: "metric-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});
