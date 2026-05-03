import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stubs for the five `renderXForm` tools. Each renders the
 * matching definition kind's form on the canvas, pre-populated with
 * `initialState`. Real implementations move from
 * apps/web/src/extensions/data-architect/tools/ in a follow-up slice
 * once the render-intent protocol (Phase 2) is in place.
 *
 * Single file because the five forms are mechanically identical at the
 * stub level — just different `kind` strings in the returned intent.
 */

const initialStateSchema = zodSchema(
  z.object({
    initialState: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Partial form state to pre-fill — names, columns, retention, grain, etc.",
      ),
  }),
);

function makeRenderFormTool(kind: string, description: string) {
  return tool({
    description,
    inputSchema: initialStateSchema,
    execute: async (input: { initialState?: Record<string, unknown> }) => ({
      stub: true,
      note: "Render-intent emission lands in Phase 2.",
      intent: {
        kind: `${kind}-form`,
        data: { initialState: input.initialState ?? {} },
      },
    }),
  });
}

export const renderEntityFormTool = makeRenderFormTool(
  "entity",
  "Render the Entity definition form on the canvas. Pre-fill via initialState.",
);

export const renderDimensionFormTool = makeRenderFormTool(
  "dimension",
  "Render the Dimension definition form on the canvas. Pre-fill via initialState.",
);

export const renderLoggerTableFormTool = makeRenderFormTool(
  "logger-table",
  "Render the Logger Table definition form on the canvas. Pre-fill via initialState.",
);

export const renderLattikTableFormTool = makeRenderFormTool(
  "lattik-table",
  "Render the Lattik Table definition form on the canvas. Pre-fill via initialState.",
);

export const renderMetricFormTool = makeRenderFormTool(
  "metric",
  "Render the Metric definition form on the canvas. Pre-fill via initialState.",
);
