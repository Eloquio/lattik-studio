import { tool, zodSchema } from "ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { definitions } from "@eloquio/db-schema";
import * as airflow from "../lib/airflow-client.js";
import { getDb } from "../../../lib/db.js";

export const getDagDetailTool = tool({
  description:
    "Get detailed info about a specific DAG: schedule, pause state, task count, max active runs. Also fetches the linked Lattik Table definition (column families, sources) if one exists.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("The Airflow DAG ID, e.g. 'lattik__user_activity'"),
    }),
  ),
  execute: async (input: { dagId: string }) => {
    try {
      const dag = await airflow.getDag(input.dagId);

      // DAG IDs follow the pattern lattik__<table_name> or
      // lattik__backfill__<table_name>. Strip both prefixes to recover the
      // Lattik Table name and look up the definition row.
      const tableName = input.dagId
        .replace(/^lattik__backfill__/, "")
        .replace(/^lattik__/, "");

      const linkedDef = await getDb()
        .select({
          id: definitions.id,
          name: definitions.name,
          kind: definitions.kind,
          version: definitions.version,
          status: definitions.status,
          spec: definitions.spec,
        })
        .from(definitions)
        .where(
          and(eq(definitions.name, tableName), eq(definitions.kind, "lattik_table")),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      return {
        dagId: dag.dag_id,
        description: dag.description,
        isPaused: dag.is_paused,
        isActive: dag.is_active,
        schedule: dag.schedule_interval,
        maxActiveRuns: dag.max_active_runs,
        maxActiveTasks: dag.max_active_tasks,
        owners: dag.owners,
        tags: dag.tags.map((t) => t.name),
        linkedDefinition: linkedDef
          ? {
              id: linkedDef.id,
              name: linkedDef.name,
              kind: linkedDef.kind,
              version: linkedDef.version,
              status: linkedDef.status,
              spec: linkedDef.spec,
            }
          : null,
      };
    } catch (err) {
      return {
        error: `Failed to get DAG detail: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
