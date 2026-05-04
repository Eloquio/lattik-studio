import { z } from "zod";
import type {
  DagRunDetailIntent,
  DagRunState,
  TaskInstanceSummary,
} from "@eloquio/render-intents";
import { strictTool } from "../../../lib/strict-tool.js";
import * as airflow from "../lib/airflow-client.js";

/**
 * `renderDagRunDetail` returns a typed `DagRunDetailIntent` (Phase 2
 * render-intent protocol). Fetches the run metadata + per-task instances
 * for one DAG run and packages them as the typed shape; the web client's
 * adapter renders the canvas. UX rendering details (header card, task
 * row colors, status badges) live in the adapter, not here.
 */

const VALID_RUN_STATES = new Set<DagRunState>([
  "queued",
  "running",
  "success",
  "failed",
]);

function asRunState(state: string | null | undefined): DagRunState | null {
  if (state && VALID_RUN_STATES.has(state as DagRunState)) {
    return state as DagRunState;
  }
  return null;
}

export const renderDagRunDetailTool = strictTool({
  description:
    "Render the detail view for a specific DAG run on the canvas. Shows a header with run metadata and each task as a row with status indicator, duration, and type. Call this after the user selects a run to inspect.",
  inputSchema: z.object({
    dagId: z.string().describe("The Airflow DAG ID"),
    dagRunId: z.string().describe("The DAG run ID to show detail for"),
  }),
  execute: async (input): Promise<DagRunDetailIntent | { error: string }> => {
    try {
      const [runsResult, tasksResult] = await Promise.all([
        airflow.listDagRuns(input.dagId, { limit: 50 }),
        airflow.listTaskInstances(input.dagId, input.dagRunId),
      ]);

      const run = runsResult.dag_runs.find(
        (r) => r.dag_run_id === input.dagRunId,
      );

      const tasks: TaskInstanceSummary[] = tasksResult.task_instances.map(
        (t) => ({
          taskId: t.task_id,
          state: t.state,
          operator: t.operator,
          startDate: t.start_date,
          endDate: t.end_date,
          durationSeconds: t.duration ? Math.round(t.duration) : null,
          tryNumber: t.try_number,
          maxTries: t.max_tries,
        }),
      );

      return {
        kind: "dag-run-detail",
        surface: "detail",
        data: {
          dagId: input.dagId,
          runId: input.dagRunId,
          logicalDate: run?.logical_date ?? null,
          runState: asRunState(run?.state),
          startDate: run?.start_date ?? null,
          endDate: run?.end_date ?? null,
          tasks,
        },
      };
    } catch (err) {
      return {
        error: `Failed to render run detail: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
