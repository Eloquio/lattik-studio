import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Phase 1 stub — render-intent emission lands in Phase 2. */
export const renderDagRunDetailTool = tool({
  description:
    "Render the run-detail canvas — task graph + log viewer for a specific DAG run.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string(),
      runId: z.string(),
    }),
  ),
  execute: async (input: { dagId: string; runId: string }) => ({
    stub: true,
    note: "Render-intent emission lands in Phase 2.",
    intent: {
      kind: "dag-run-detail",
      data: { dagId: input.dagId, runId: input.runId, tasks: [] },
    },
  }),
});
