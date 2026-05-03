import { tool, zodSchema } from "ai";
import { z } from "zod";
import * as airflow from "../lib/airflow-client.js";

export const listDagsTool = tool({
  description:
    "List all Lattik-managed Airflow DAGs. Returns DAG ID, description, schedule, paused status, and tags. Only shows DAGs tagged 'lattik' — unrelated DAGs are filtered out.",
  inputSchema: zodSchema(
    z.object({
      limit: z
        .number()
        .optional()
        .describe("Max number of DAGs to return (default 50)"),
    }),
  ),
  execute: async (input: { limit?: number }) => {
    try {
      const result = await airflow.listDags({
        tags: ["lattik"],
        limit: input.limit ?? 50,
      });
      return {
        count: result.dags.length,
        totalEntries: result.total_entries,
        dags: result.dags.map((d) => ({
          dagId: d.dag_id,
          description: d.description,
          isPaused: d.is_paused,
          isActive: d.is_active,
          schedule: d.schedule_interval,
          tags: d.tags.map((t) => t.name),
          nextRun: d.next_dagrun,
        })),
      };
    } catch (err) {
      return {
        error: `Failed to list DAGs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
