import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Phase 1 stub — real implementation pending. */
export const getTaskInstancesTool = tool({
  description:
    "List task instances for a specific DAG run — state, duration, try number.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string(),
      runId: z.string(),
    }),
  ),
  execute: async (input: { dagId: string; runId: string }) => ({
    stub: true,
    note: "Real implementation pending — moves from apps/web in a follow-up slice.",
    dagId: input.dagId,
    runId: input.runId,
    tasks: [],
  }),
});
