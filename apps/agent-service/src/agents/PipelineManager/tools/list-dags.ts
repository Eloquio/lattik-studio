import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stub. Real implementation will move from
 * apps/web/src/extensions/pipeline-manager/tools/list-dags.ts and call the
 * Airflow REST API via a per-runtime client (apps/agent-service/src/lib/
 * airflow-client.ts, not yet created).
 */
export const listDagsTool = tool({
  description:
    "List all Lattik-managed Airflow DAGs (filtered by `lattik` tag). Returns each DAG's id, schedule, paused state, last run outcome, and a sparkline of recent runs.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => ({
    stub: true,
    note: "Real implementation pending — Airflow REST integration moves here in a follow-up slice.",
    dags: [],
  }),
});
