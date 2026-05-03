import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ChartIntent, SqlEditorIntent } from "@eloquio/render-intents";

/**
 * Data Analyst's pure-render tools — sql-editor and chart. Both emit
 * typed render-intents directly; no Trino call, no canvas state to
 * thread through.
 *
 * `updateLayout` stays stubbed — it changes how surfaces are arranged
 * on the canvas, which is web-canvas-only UX. There's no semantic
 * intent for "rearrange the layout"; if we need to control layout from
 * the agent in the future, model it as a typed action the canvas
 * interprets, not as a render-intent.
 */

export const renderSqlEditorTool = tool({
  description:
    "Render an editable SQL editor on the canvas. The user can review and modify the query before running it. " +
    "Call this BEFORE runQuery to let the user see the SQL first.",
  inputSchema: zodSchema(
    z.object({
      sql: z.string().describe("The SQL query to display in the editor"),
    }),
  ),
  execute: async (input: { sql: string }): Promise<SqlEditorIntent> => ({
    kind: "sql-editor",
    surface: "editor",
    data: { sql: input.sql },
  }),
});

export const renderChartTool = tool({
  description:
    "Add or update a chart visualization based on the most recent query results. " +
    "The query must have been executed first (via runQuery). Choose the chart type and map columns to axes.",
  inputSchema: zodSchema(
    z.object({
      type: z.enum(["bar", "line", "area", "pie", "scatter"]),
      title: z.string().optional(),
      xColumn: z.string(),
      yColumns: z.array(z.string()).min(1),
    }),
  ),
  execute: async (input: {
    type: "bar" | "line" | "area" | "pie" | "scatter";
    title?: string;
    xColumn: string;
    yColumns: string[];
  }): Promise<ChartIntent> => ({
    kind: "chart",
    surface: "chart",
    data: {
      chartType: input.type,
      xColumn: input.xColumn,
      yColumns: input.yColumns,
      title: input.title,
    },
  }),
});

/**
 * `updateLayout` stays stubbed for now — the existing tool reconfigures
 * apps/web's canvas surface arrangement (which surfaces are visible /
 * stacked), which is a web-canvas concern that doesn't translate to the
 * render-intent model. Layout-as-protocol is reserved for a possible
 * Phase 3 typed-action; for v2, surfaces appear when their first intent
 * is emitted.
 */
export const updateLayoutTool = tool({
  description:
    "Reconfigure how the canvas surfaces are arranged on screen.",
  inputSchema: zodSchema(
    z.object({
      layout: z.array(z.string()),
    }),
  ),
  execute: async (input) => ({
    stub: true,
    note: "Layout reconfiguration is a web-canvas concern; not modeled as a render-intent.",
    data: input,
  }),
});
