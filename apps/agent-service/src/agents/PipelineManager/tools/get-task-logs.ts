import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Phase 1 stub — real implementation pending. */
export const getTaskLogsTool = tool({
  description:
    "Fetch stdout/stderr logs for a specific task instance (Spark driver output, sensor poke output).",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string(),
      runId: z.string(),
      taskId: z.string(),
      tryNumber: z.number().int().positive().optional(),
    }),
  ),
  execute: async (input: {
    dagId: string;
    runId: string;
    taskId: string;
    tryNumber?: number;
  }) => ({
    stub: true,
    note: "Real implementation pending — moves from apps/web in a follow-up slice.",
    ...input,
    logs: "",
  }),
});
