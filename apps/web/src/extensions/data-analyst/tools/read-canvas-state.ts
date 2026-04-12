import { zodSchema } from "ai";
import { z } from "zod";
import { extractAnalystState } from "../spec-builder";

export function createReadCanvasStateTool(getCanvasState: () => unknown) {
  return {
    description:
      "Read the current Data Analyst canvas state. Returns the SQL query, " +
      "query results metadata (column names, row count), and chart configuration if any.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const state = extractAnalystState(getCanvasState());

      // Return a summarized view — don't send all rows to the agent
      return {
        sql: state.sql ?? null,
        queryStatus: state.queryStatus ?? null,
        columns: state.columns ?? null,
        rowCount: state.rowCount ?? null,
        duration: state.duration ?? null,
        truncated: state.truncated ?? null,
        chart: state.chart ?? null,
        queryError: state.queryError ?? null,
      };
    },
  };
}
