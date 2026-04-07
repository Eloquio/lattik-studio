import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import {
  entityFormInitialStateSchema,
  dimensionFormInitialStateSchema,
  loggerTableFormInitialStateSchema,
  lattikTableFormInitialStateSchema,
  metricFormInitialStateSchema,
  buildEntityFormSpec,
  buildDimensionFormSpec,
  buildLoggerTableFormSpec,
  buildLattikTableFormSpec,
  buildMetricFormSpec,
} from "../form-spec-builders";

/**
 * The render*Form tools replace the old "emit JSONL spec patches in a code
 * fence" pattern. Instead of free-form generating spec patches (which exposed
 * the agent to LLM token-loop bugs and required defensive sanitization on
 * every downstream surface), the agent now calls one of these tools with
 * structured initial state, and the canonical Spec is built deterministically
 * by the per-kind functions in form-spec-builders.ts. The LLM never produces
 * raw spec patches.
 *
 * One tool per kind (rather than a single tool with `z.discriminatedUnion`)
 * because Anthropic's tool-use API requires every input schema to be a plain
 * object at the root — discriminated unions serialize to top-level `anyOf`
 * which the API rejects. Per-kind tools are also more discoverable for the
 * model: it picks the right tool directly instead of having to navigate a
 * union variant.
 *
 * Output shape is always `{kind, spec, instruction}`. The chat-panel watches
 * for any tool result whose name matches `tool-render*Form` and pushes the
 * spec into the canvas via the same applyStreamSpec path used by the legacy
 * JSONL stream rebuild.
 */

const RENDER_INSTRUCTION =
  "The form is now on the canvas. Do NOT emit any spec code fence — the form is already rendered. Acknowledge briefly in prose (one sentence summarizing what was pre-filled) and wait for the user to either edit the form or ask you to review/save it.";

function makeRenderFormTool<S extends z.ZodTypeAny, K extends string>(
  kind: K,
  description: string,
  initialStateSchema: S,
  builder: (initialState: z.infer<S>) => Spec
) {
  return {
    description,
    inputSchema: zodSchema(
      z.object({
        initialState: initialStateSchema,
      })
    ),
    execute: async (input: { initialState: z.infer<S> }) => {
      const spec = builder(input.initialState);
      return {
        kind,
        spec,
        instruction: RENDER_INSTRUCTION,
      };
    },
  };
}

export const renderEntityFormTool = makeRenderFormTool(
  "entity",
  "Render the Entity definition form on the canvas. Pass any initial state values you can glean from the user's request — name, description, id_field, id_type. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  entityFormInitialStateSchema,
  buildEntityFormSpec
);

export const renderDimensionFormTool = makeRenderFormTool(
  "dimension",
  "Render the Dimension definition form on the canvas. Pass any initial state values you can glean from the user's request — name, description, entity, source_table, source_column, data_type. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  dimensionFormInitialStateSchema,
  buildDimensionFormSpec
);

export const renderLoggerTableFormTool = makeRenderFormTool(
  "logger_table",
  "Render the Logger Table definition form on the canvas. Pass any initial state values you can glean from the user's request — name (in 'schema.table_name' format), description, retention, dedup_window, and user_columns (an array of {name, type, dimension?, description?, pii?}). Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  loggerTableFormInitialStateSchema,
  buildLoggerTableFormSpec
);

export const renderLattikTableFormTool = makeRenderFormTool(
  "lattik_table",
  "Render the Lattik Table definition form on the canvas. Pass any initial state values you can glean from the user's request — name, description, retention, primary_key, column_families, derived_columns. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  lattikTableFormInitialStateSchema,
  buildLattikTableFormSpec
);

export const renderMetricFormTool = makeRenderFormTool(
  "metric",
  "Render the Metric definition form on the canvas. Pass any initial state values you can glean from the user's request — name, description, calculations. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  metricFormInitialStateSchema,
  buildMetricFormSpec
);

/**
 * Set of tool name suffixes that the chat-panel renderForm watcher should
 * recognize. The watcher checks if a tool result's name appears in this set
 * (after stripping the `tool-` prefix) and, if so, treats its `output.spec`
 * field as a canvas spec to apply.
 */
export const RENDER_FORM_TOOL_NAMES = new Set([
  "renderEntityForm",
  "renderDimensionForm",
  "renderLoggerTableForm",
  "renderLattikTableForm",
  "renderMetricForm",
]);
