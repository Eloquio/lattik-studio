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
import { loadMergedDimensions } from "../validation/referential";

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

// Defense-in-depth: strip any `dimension` references on user_columns that
// don't correspond to an existing merged Dimension. The skill doc already
// forbids the agent from inventing bindings, but LLMs occasionally drift —
// this guarantees the canvas never shows a binding that will fail static
// check. Dropped bindings are surfaced in the tool result so the agent can
// mention them to the user.
async function stripUnknownDimensions(
  initialState: z.infer<typeof loggerTableFormInitialStateSchema>
): Promise<{
  initialState: z.infer<typeof loggerTableFormInitialStateSchema>;
  dropped: Array<{ column: string; dimension: string }>;
}> {
  const userColumns = initialState.user_columns ?? [];
  const hasBindings = userColumns.some((c) => c.dimension);
  if (!hasBindings) return { initialState, dropped: [] };

  // Fail-open on DB trouble: if we can't load the dimension list, leave the
  // bindings as-is and let static check catch any stragglers. A render-time
  // DB hiccup should not block the user from seeing their form.
  let existingNames: Set<string>;
  try {
    const merged = await loadMergedDimensions();
    existingNames = new Set(merged.map((d) => d.name));
  } catch {
    return { initialState, dropped: [] };
  }

  const dropped: Array<{ column: string; dimension: string }> = [];
  const cleanedColumns = userColumns.map((col) => {
    if (col.dimension && !existingNames.has(col.dimension)) {
      dropped.push({ column: col.name, dimension: col.dimension });
      const { dimension: _stripped, ...rest } = col;
      return rest;
    }
    return col;
  });

  return {
    initialState: { ...initialState, user_columns: cleanedColumns },
    dropped,
  };
}

export const renderLoggerTableFormTool = {
  description:
    "Render the Logger Table definition form on the canvas. Pass any initial state values you can glean from the user's request — name (in 'schema.table_name' format), description, retention, dedup_window, and user_columns (an array of {name, type, dimension?, description?, classification?}). `classification` is an object with optional boolean flags {pii, phi, financial, credentials} — set any that apply. Implicit columns (event_id, event_timestamp, ds, hour) are added automatically — do NOT include them. **IMPORTANT:** only set `dimension` on a column if you have verified via `listDefinitions({kind: \"dimension\"})` that the dimension already exists; otherwise omit the field. Unknown dimension references will be stripped and returned in `droppedDimensionBindings`. The form appears immediately and the user fills in the rest. Use this INSTEAD of emitting any spec code fence.",
  inputSchema: zodSchema(
    z.object({
      initialState: loggerTableFormInitialStateSchema,
    })
  ),
  execute: async (input: {
    initialState: z.infer<typeof loggerTableFormInitialStateSchema>;
  }) => {
    const { initialState, dropped } = await stripUnknownDimensions(
      input.initialState
    );
    const spec = buildLoggerTableFormSpec(initialState);
    const instruction =
      dropped.length > 0
        ? `${RENDER_INSTRUCTION} NOTE: ${dropped.length} dimension binding${
            dropped.length === 1 ? "" : "s"
          } pointed to non-existent dimensions and were stripped — ${dropped
            .map((d) => `${d.column} → ${d.dimension}`)
            .join(
              ", "
            )}. Briefly tell the user which dimensions would need to be defined first if they want those bindings.`
        : RENDER_INSTRUCTION;
    return {
      kind: "logger_table" as const,
      spec,
      instruction,
      droppedDimensionBindings: dropped,
    };
  },
};

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
