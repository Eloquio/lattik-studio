import { z } from "zod";
import { strictTool } from "../../../lib/strict-tool.js";
import * as airflow from "../lib/airflow-client.js";

export const listDagRunsTool = strictTool({
  description:
    "List recent runs for a specific DAG. Returns run ID, logical date, state (queued/running/success/failed), start/end times, and duration. Newest first by default.",
  inputSchema: z.object({
    dagId: z.string().describe("The Airflow DAG ID"),
    limit: z
      .number()
      .optional()
      .describe("Max number of runs to return (default 10)"),
  }),
  execute: async (input) => {
    try {
      const result = await airflow.listDagRuns(input.dagId, {
        limit: input.limit ?? 10,
        orderBy: "-start_date",
      });
      return {
        dagId: input.dagId,
        count: result.dag_runs.length,
        totalEntries: result.total_entries,
        runs: result.dag_runs.map((r) => ({
          runId: r.dag_run_id,
          logicalDate: r.logical_date,
          state: r.state,
          startDate: r.start_date,
          endDate: r.end_date,
          durationSeconds:
            r.start_date && r.end_date
              ? Math.round(
                  (new Date(r.end_date).getTime() - new Date(r.start_date).getTime()) / 1000,
                )
              : null,
        })),
      };
    } catch (err) {
      return {
        error: `Failed to list DAG runs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
