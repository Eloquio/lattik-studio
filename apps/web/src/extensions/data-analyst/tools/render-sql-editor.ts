import { zodSchema } from "ai";
import { z } from "zod";
import {
  buildAnalystCanvasSpec,
  extractAnalystState,
} from "../spec-builder";

export function createRenderSqlEditorTool(getCanvasState: () => unknown) {
  return {
    description:
      "Render an editable SQL editor on the canvas. The user can review and modify the query before running it. " +
      "Call this BEFORE runQuery to let the user see the SQL first.",
    inputSchema: zodSchema(
      z.object({
        sql: z.string().describe("The SQL query to display in the editor"),
      })
    ),
    execute: async (input: { sql: string }) => {
      const current = extractAnalystState(getCanvasState());
      const spec = buildAnalystCanvasSpec({
        ...current,
        sql: input.sql,
        // Clear previous results when showing new SQL
        columns: undefined,
        rows: undefined,
        queryStatus: undefined,
        queryError: undefined,
        duration: undefined,
        rowCount: undefined,
        truncated: undefined,
        chart: undefined,
      });

      return {
        spec,
        instruction:
          "SQL editor is displayed on the canvas. The user can edit the query. " +
          "Ask if they want to run it, or run it directly if the user already asked for results.",
      };
    },
  };
}
