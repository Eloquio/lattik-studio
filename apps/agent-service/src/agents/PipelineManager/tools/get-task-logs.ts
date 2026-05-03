import { tool, zodSchema } from "ai";
import { z } from "zod";
import * as airflow from "../lib/airflow-client.js";

const MAX_LOG_LINES = 200;

export const getTaskLogsTool = tool({
  description:
    "Fetch stdout/stderr logs for a specific task instance. Useful for diagnosing why a task failed. Returns the last 200 lines by default — for Spark tasks, the error is usually near the end.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("The Airflow DAG ID"),
      dagRunId: z.string().describe("The DAG run ID"),
      taskId: z.string().describe("The task ID (e.g. 'build__user_activity')"),
      tryNumber: z
        .number()
        .optional()
        .describe("Which try to fetch logs for (default: latest)"),
    }),
  ),
  execute: async (input: {
    dagId: string;
    dagRunId: string;
    taskId: string;
    tryNumber?: number;
  }) => {
    try {
      const logs = await airflow.getTaskLogs(
        input.dagId,
        input.dagRunId,
        input.taskId,
        { tryNumber: input.tryNumber },
      );
      const lines = logs.split("\n");
      const truncated = lines.length > MAX_LOG_LINES;
      const tail = truncated ? lines.slice(-MAX_LOG_LINES) : lines;
      return {
        dagId: input.dagId,
        dagRunId: input.dagRunId,
        taskId: input.taskId,
        tryNumber: input.tryNumber ?? 1,
        totalLines: lines.length,
        truncated,
        logs: tail.join("\n"),
      };
    } catch (err) {
      return {
        error: `Failed to get task logs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
