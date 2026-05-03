import { tool, zodSchema } from "ai";
import { z } from "zod";
import type {
  EntityFormIntent,
  DimensionFormIntent,
  LoggerTableFormIntent,
  LattikTableFormIntent,
  MetricFormIntent,
} from "@eloquio/render-intents";

/**
 * The five Data Architect form-render tools, ported to typed
 * render-intents. Each emits its kind-matching intent on the
 * `form` surface; the json-render-adapter handles the actual
 * Spec composition (with per-kind initial-state schema validation
 * as the trust boundary).
 *
 * The agent passes initial-state values it can glean from the
 * user's request as a loose `Record<string, unknown>` — the
 * adapter validates against each kind's typed schema. Untyped on
 * the agent side keeps the tool input schemas simple (Anthropic's
 * tool-use API doesn't accept top-level `anyOf` so per-kind unions
 * don't serialize cleanly).
 */

const initialStateInputSchema = zodSchema(
  z.object({
    initialState: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Partial form state to pre-fill. Pass any names, columns, retention, grain, or other values you can glean from the user's request — every field is optional. The user fills in the rest.",
      ),
  }),
);

export const renderEntityFormTool = tool({
  description:
    "Render the Entity definition form on the canvas. Pre-fill via initialState (name, description, id_field, id_type).",
  inputSchema: initialStateInputSchema,
  execute: async (input: {
    initialState?: Record<string, unknown>;
  }): Promise<EntityFormIntent> => ({
    kind: "entity-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderDimensionFormTool = tool({
  description:
    "Render the Dimension definition form on the canvas. Pre-fill via initialState (name, description, entity, source_table, source_column, data_type).",
  inputSchema: initialStateInputSchema,
  execute: async (input: {
    initialState?: Record<string, unknown>;
  }): Promise<DimensionFormIntent> => ({
    kind: "dimension-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderLoggerTableFormTool = tool({
  description:
    "Render the Logger Table definition form on the canvas. Pre-fill via initialState (name, description, retention, dedup_window, user_columns).",
  inputSchema: initialStateInputSchema,
  execute: async (input: {
    initialState?: Record<string, unknown>;
  }): Promise<LoggerTableFormIntent> => ({
    kind: "logger-table-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderLattikTableFormTool = tool({
  description:
    "Render the Lattik Table definition form on the canvas. Pre-fill via initialState (name, description, primary_key, column_families, derived_columns, backfill).",
  inputSchema: initialStateInputSchema,
  execute: async (input: {
    initialState?: Record<string, unknown>;
  }): Promise<LattikTableFormIntent> => ({
    kind: "lattik-table-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});

export const renderMetricFormTool = tool({
  description:
    "Render the Metric definition form on the canvas. Pre-fill via initialState (name, description, calculations).",
  inputSchema: initialStateInputSchema,
  execute: async (input: {
    initialState?: Record<string, unknown>;
  }): Promise<MetricFormIntent> => ({
    kind: "metric-form",
    surface: "form",
    data: { initialState: input.initialState ?? {} },
  }),
});
