import { zodSchema } from "ai";
import { z } from "zod";
import { executeQuery, TrinoQueryError } from "../lib/trino-client";
import { executeDuckDbQuery, isLattikScanQuery } from "../lib/duckdb-client";
import {
  buildAnalystCanvasSpec,
  extractAnalystState,
} from "../spec-builder";

/** Max rows to return to the agent for reasoning (keeps context small). */
const AGENT_SAMPLE_SIZE = 20;

export function createRunQueryTool(
  getCanvasState: () => unknown,
  setCanvasState: (spec: unknown) => void
) {
  return {
    description:
      "Execute a SQL query against Trino and display results on the canvas. " +
      "If sql is omitted, reads the query from the canvas SQL editor (the user may have edited it). " +
      "Returns column metadata and a sample of rows for reasoning about chart suggestions.",
    inputSchema: zodSchema(
      z.object({
        sql: z
          .string()
          .optional()
          .describe(
            "SQL to execute. Omit to use the query currently in the canvas SQL editor."
          ),
      })
    ),
    execute: async (input: { sql?: string }) => {
      const current = extractAnalystState(getCanvasState());
      const sql = input.sql ?? current.sql;

      if (!sql) {
        return { error: "No SQL query provided and none found in canvas state." };
      }

      try {
        const result = isLattikScanQuery(sql)
          ? await executeDuckDbQuery(sql)
          : await executeQuery(sql);
        const durationStr = result.durationMs < 1000
          ? `${result.durationMs}ms`
          : `${(result.durationMs / 1000).toFixed(2)}s`;

        const spec = buildAnalystCanvasSpec({
          ...current,
          sql,
          columns: result.columns,
          rows: result.rows,
          queryStatus: "success",
          queryError: undefined,
          duration: durationStr,
          rowCount: result.rowCount,
          truncated: result.truncated,
          // Preserve chart if column names are still compatible, otherwise clear
          chart: current.chart && columnsStillMatch(current.chart, result.columns.map((c) => c.name))
            ? current.chart
            : undefined,
        });

        setCanvasState(spec);

        return {
          spec,
          columns: result.columns,
          rowCount: result.rowCount,
          sampleRows: result.rows.slice(0, AGENT_SAMPLE_SIZE),
          duration: durationStr,
          truncated: result.truncated,
          instruction:
            "Results are displayed on the canvas. You can now suggest a chart visualization using renderChart, " +
            "or let the user know the results are ready.",
        };
      } catch (err) {
        const message =
          err instanceof TrinoQueryError
            ? err.message
            : (err as Error).message;

        const spec = buildAnalystCanvasSpec({
          ...current,
          sql,
          queryStatus: "error",
          queryError: message,
          columns: undefined,
          rows: undefined,
          duration: undefined,
          rowCount: undefined,
          truncated: undefined,
          chart: undefined,
        });

        setCanvasState(spec);

        return {
          spec,
          error: message,
          instruction:
            "The query failed. The error is shown on the canvas. " +
            "Help the user fix the SQL and try again.",
        };
      }
    },
  };
}

function columnsStillMatch(
  chart: { xColumn: string; yColumns: string[] },
  columnNames: string[]
): boolean {
  const nameSet = new Set(columnNames);
  if (!nameSet.has(chart.xColumn)) return false;
  return chart.yColumns.every((y) => nameSet.has(y));
}
