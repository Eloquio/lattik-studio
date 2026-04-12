import { zodSchema } from "ai";
import { z } from "zod";
import {
  buildAnalystCanvasSpec,
  extractAnalystState,
} from "../spec-builder";

export function createUpdateLayoutTool(
  getCanvasState: () => unknown,
  setCanvasState: (spec: unknown) => void
) {
  return {
    description:
      "Show or hide canvas panels. Use this when the user wants to toggle visibility " +
      "of the SQL editor, results table, or chart.",
    inputSchema: zodSchema(
      z.object({
        showSql: z
          .boolean()
          .optional()
          .describe("Show or hide the SQL editor panel"),
        showResults: z
          .boolean()
          .optional()
          .describe("Show or hide the results table"),
        showChart: z
          .boolean()
          .optional()
          .describe("Show or hide the chart"),
      })
    ),
    execute: async (input: {
      showSql?: boolean;
      showResults?: boolean;
      showChart?: boolean;
    }) => {
      const current = extractAnalystState(getCanvasState());

      const spec = buildAnalystCanvasSpec({
        ...current,
        showSql: input.showSql ?? current.showSql,
        showResults: input.showResults ?? current.showResults,
        showChart: input.showChart ?? current.showChart,
      });

      setCanvasState(spec);

      return {
        spec,
        instruction: "Canvas layout updated.",
      };
    },
  };
}
