import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { definitions } from "@eloquio/db-schema";
import { strictTool } from "../../../lib/strict-tool.js";
import * as airflow from "../lib/airflow-client.js";
import { assertLattikDagId } from "../lib/airflow-client.js";
import { getDb } from "../../../lib/db.js";

export const getDagDetailTool = strictTool({
  description:
    "Get detailed info about a specific DAG: schedule, pause state, task count, max active runs. Also fetches the linked Lattik Table definition (column families, sources) if one exists.",
  inputSchema: z.object({
    dagId: z
      .string()
      .describe("The Airflow DAG ID, e.g. 'lattik__user_activity'"),
  }),
  execute: async (input) => {
    try {
      assertLattikDagId(input.dagId);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // Airflow GET is load-bearing — if it fails the tool fails. The DB
    // lookup for the linked Lattik-Table definition is supplementary
    // (it enriches the DAG with column families etc.); a DB outage must
    // not turn the whole tool into an error. The two calls are independent,
    // so fire them in parallel and resolve the soft-error case afterwards.
    //
    // DAG IDs follow the pattern lattik__<table_name> or
    // lattik__backfill__<table_name>. Strip both prefixes to recover
    // the Lattik Table name.
    const tableName = input.dagId
      .replace(/^lattik__backfill__/, "")
      .replace(/^lattik__/, "");

    const [dagResult, linkedDefResult] = await Promise.allSettled([
      airflow.getDag(input.dagId),
      getDb()
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
        .then((rows) => rows[0] ?? null),
    ]);

    if (dagResult.status === "rejected") {
      const err = dagResult.reason;
      return {
        error: `Failed to get DAG detail: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const dag = dagResult.value;
    const linkedDef = linkedDefResult.status === "fulfilled" ? linkedDefResult.value : null;
    const linkedDefError =
      linkedDefResult.status === "rejected"
        ? linkedDefResult.reason instanceof Error
          ? linkedDefResult.reason.message
          : String(linkedDefResult.reason)
        : null;

    return {
      dagId: dag.dag_id,
      description: dag.description,
      isPaused: dag.is_paused,
      // Same Airflow 3.x adaptation as `renderDagOverview` — `is_active`
      // and `schedule_interval` aren't in the v3 detail response.
      isActive: dag.is_active ?? (!dag.is_paused && !dag.is_stale),
      schedule: dag.schedule_interval ?? dag.timetable_summary ?? null,
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
      linkedDefinitionError: linkedDefError,
    };
  },
});
