import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stub. The final shape (Phase 2) emits a render-intent — a
 * semantic instruction the per-client adapter (json-render on web, Block
 * Kit on Slack, …) renders into its native UI. For now the tool returns
 * a placeholder so the agent can call it without crashing.
 */
export const renderDagOverviewTool = tool({
  description:
    "Render the DAG overview canvas — list of Lattik-managed DAGs with status badges and recent-run sparklines. ALWAYS call this first when answering DAG monitoring questions.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => ({
    stub: true,
    note: "Render-intent emission lands in Phase 2.",
    intent: { kind: "dag-overview", data: { dags: [] } },
  }),
});
