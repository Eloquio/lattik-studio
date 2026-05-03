import { tool, zodSchema } from "ai";
import { z } from "zod";
import type {
  DagOverviewIntent,
  DagRunState,
  DagSummary,
} from "@eloquio/render-intents";
import * as airflow from "../lib/airflow-client.js";

/**
 * `renderDagOverview` returns a typed `DagOverviewIntent` (Phase 2 render-
 * intent protocol). The web client's json-render adapter recognizes the
 * `kind: "dag-overview"` discriminator and renders the DAG list; Slack/
 * Discord adapters can consume the same intent and render natively.
 *
 * The tool fetches DAGs filtered by the `lattik` tag, then enriches each
 * with last-run + recent-runs state via Airflow's listDagRuns. UX
 * affordances (color-coded rows, sparkline) live in the adapters; the
 * intent only carries data.
 */

const RUN_HISTORY_LIMIT = 10;
const DAG_LIMIT = 50;

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

export const renderDagOverviewTool = tool({
  description:
    "Render the DAG overview on the canvas. Shows all Lattik-managed DAGs as cards with status badges, schedule, last run result, and visual run history. This is the starting point for any monitoring workflow. Call this BEFORE writing prose.",
  inputSchema: zodSchema(z.object({})),
  execute: async (): Promise<DagOverviewIntent | { error: string }> => {
    try {
      const dagResult = await airflow.listDags({
        tags: ["lattik"],
        limit: DAG_LIMIT,
      });

      const dags: DagSummary[] = await Promise.all(
        dagResult.dags.map(async (dag): Promise<DagSummary> => {
          let lastRunState: DagRunState | null = null;
          const recentRunStates: DagRunState[] = [];
          try {
            const runs = await airflow.listDagRuns(dag.dag_id, {
              limit: RUN_HISTORY_LIMIT,
              orderBy: "-start_date",
            });
            if (runs.dag_runs.length > 0) {
              lastRunState = asRunState(runs.dag_runs[0].state);
            }
            for (const r of runs.dag_runs) {
              const state = asRunState(r.state);
              if (state) recentRunStates.push(state);
            }
          } catch {
            // If runs fetch fails, render the DAG anyway with no run history.
            // The agent can still answer "what DAGs exist" even if Airflow's
            // dag-runs endpoint hiccups for a specific DAG.
          }

          return {
            dagId: dag.dag_id,
            description: dag.description,
            isPaused: dag.is_paused,
            // Airflow 3.x list response doesn't have `is_active`. Derive it:
            // a non-paused, non-stale DAG is active.
            isActive: dag.is_active ?? (!dag.is_paused && !dag.is_stale),
            // Same for `schedule_interval` — fall back to the new
            // `timetable_summary` field, then null. Coerce undefined → null
            // so the field is present on the wire (JSON.stringify drops
            // undefined; the render-intent schema requires the key).
            schedule: dag.schedule_interval ?? dag.timetable_summary ?? null,
            tags: dag.tags.map((t) => t.name),
            nextRun: dag.next_dagrun ?? null,
            lastRunState,
            recentRunStates,
          };
        }),
      );

      return {
        kind: "dag-overview",
        surface: "main",
        data: {
          dags,
          totalEntries: dagResult.total_entries,
        },
      };
    } catch (err) {
      return {
        error: `Failed to render DAG overview: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
