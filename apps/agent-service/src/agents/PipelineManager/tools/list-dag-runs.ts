import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Phase 1 stub — real implementation pending. */
export const listDagRunsTool = tool({
  description:
    "List the recent runs of a DAG — state, logical date, start/end time, duration.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("DAG id"),
      limit: z.number().int().positive().optional().describe("Max runs to return"),
    }),
  ),
  execute: async (input: { dagId: string; limit?: number }) => ({
    stub: true,
    note: "Real implementation pending — moves from apps/web in a follow-up slice.",
    dagId: input.dagId,
    runs: [],
  }),
});
