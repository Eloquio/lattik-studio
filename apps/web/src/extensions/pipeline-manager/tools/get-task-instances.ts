import { zodSchema } from "ai";
import { z } from "zod";
import * as airflow from "../lib/airflow-client";

export const getTaskInstancesTool = {
  description:
    "Get all task instances for a specific DAG run. Returns task ID, state, duration, try number, and operator type. Use this to see which tasks succeeded, failed, or are still running.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("The Airflow DAG ID"),
      dagRunId: z
        .string()
        .describe("The DAG run ID (from listDagRuns)"),
    })
  ),
  execute: async (input: { dagId: string; dagRunId: string }) => {
    try {
      const result = await airflow.listTaskInstances(
        input.dagId,
        input.dagRunId
      );

      return {
        dagId: input.dagId,
        dagRunId: input.dagRunId,
        count: result.task_instances.length,
        tasks: result.task_instances.map((t) => ({
          taskId: t.task_id,
          state: t.state,
          operator: t.operator,
          startDate: t.start_date,
          endDate: t.end_date,
          durationSeconds: t.duration ? Math.round(t.duration) : null,
          tryNumber: t.try_number,
          maxTries: t.max_tries,
        })),
      };
    } catch (err) {
      return {
        error: `Failed to get task instances: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
