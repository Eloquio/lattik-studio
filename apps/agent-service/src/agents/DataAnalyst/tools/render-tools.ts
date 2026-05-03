import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stubs for Data Analyst's canvas-render tools. Render-intent
 * emission is Phase 2 work; for now each returns a placeholder so the
 * agent can call them without crashing.
 */

const stub = (kind: string) =>
  ({ stub: true, note: "Render-intent emission lands in Phase 2.", intent: { kind } });

export const renderSqlEditorTool = tool({
  description:
    "Render an editable, syntax-highlighted SQL editor on the canvas. Pass the initial SQL via `sql`; the user can edit before running.",
  inputSchema: zodSchema(
    z.object({
      sql: z.string().describe("Initial SQL to populate the editor with."),
    }),
  ),
  execute: async (input) => ({ ...stub("sql-editor"), data: { sql: input.sql } }),
});

export const renderChartTool = tool({
  description:
    "Render a chart visualization of the most recent query result.",
  inputSchema: zodSchema(
    z.object({
      type: z.enum(["bar", "line", "area", "pie", "scatter"]),
      x: z.string().describe("Column to use on the x axis."),
      y: z.string().describe("Column to use on the y axis."),
      title: z.string().optional(),
    }),
  ),
  execute: async (input) => ({ ...stub("chart"), data: input }),
});

export const updateLayoutTool = tool({
  description:
    "Reconfigure how the canvas surfaces are arranged on screen (e.g. SQL editor + result table + chart).",
  inputSchema: zodSchema(
    z.object({
      layout: z
        .array(z.string())
        .describe("Ordered list of canvas surfaces to show, top to bottom."),
    }),
  ),
  execute: async (input) => ({ ...stub("layout"), data: input }),
});
