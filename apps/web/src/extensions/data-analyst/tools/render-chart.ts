import { zodSchema } from "ai";
import { z } from "zod";
import {
  buildAnalystCanvasSpec,
  extractAnalystState,
  type ChartType,
} from "../spec-builder";

export function createRenderChartTool(getCanvasState: () => unknown) {
  return {
    description:
      "Add or update a chart visualization on the canvas based on the current query results. " +
      "The query must have been executed first (via runQuery). Choose the chart type and map columns " +
      "to axes. The chart renders below the results table.",
    inputSchema: zodSchema(
      z.object({
        type: z
          .enum(["bar", "line", "area", "pie", "scatter"])
          .describe("Chart type"),
        title: z
          .string()
          .optional()
          .describe("Chart title (shown above the chart)"),
        xColumn: z
          .string()
          .describe("Column name to use for the x-axis (or pie labels)"),
        yColumns: z
          .array(z.string())
          .min(1)
          .describe(
            "Column name(s) for y-axis values. Multiple columns create multi-series charts."
          ),
      })
    ),
    execute: async (input: {
      type: ChartType;
      title?: string;
      xColumn: string;
      yColumns: string[];
    }) => {
      const current = extractAnalystState(getCanvasState());

      if (!current.columns || !current.rows) {
        return {
          error:
            "No query results available. Run a query first using runQuery before rendering a chart.",
        };
      }

      // Validate that referenced columns exist
      const columnNames = new Set(current.columns.map((c) => c.name));
      const missing: string[] = [];
      if (!columnNames.has(input.xColumn)) missing.push(input.xColumn);
      for (const y of input.yColumns) {
        if (!columnNames.has(y)) missing.push(y);
      }
      if (missing.length > 0) {
        return {
          error: `Column(s) not found in query results: ${missing.join(", ")}. Available columns: ${[...columnNames].join(", ")}`,
        };
      }

      const spec = buildAnalystCanvasSpec({
        ...current,
        chart: {
          type: input.type,
          title: input.title,
          xColumn: input.xColumn,
          yColumns: input.yColumns,
        },
      });

      return {
        spec,
        instruction:
          "Chart is displayed on the canvas. The user can ask to change the chart type, " +
          "columns, or ask follow-up questions about the data.",
      };
    },
  };
}
