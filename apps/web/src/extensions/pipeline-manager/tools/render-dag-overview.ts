import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import * as airflow from "../lib/airflow-client";

const RENDER_INSTRUCTION =
  "The DAG overview is now on the canvas. Do NOT repeat the DAG list in chat. Acknowledge briefly (one sentence) and wait for the user to ask about a specific DAG or click a row.";

function buildDagOverviewSpec(
  dags: Array<{
    dagId: string;
    description: string | null;
    isPaused: boolean;
    isActive: boolean;
    schedule: unknown;
    lastRunState: string | null;
    runSummary: { success: number; failed: number; running: number };
  }>
): Spec {
  return {
    root: "main",
    elements: {
      main: {
        type: "Section",
        props: {},
        children: ["heading", "table"],
      },
      heading: {
        type: "Heading",
        props: {
          title: "Lattik DAG Overview",
          subtitle: `${dags.length} managed DAG${dags.length !== 1 ? "s" : ""}`,
        },
      },
      table: {
        type: "DataTable",
        props: {
          columns: [
            { key: "dagId", label: "DAG" },
            { key: "status", label: "Status" },
            { key: "schedule", label: "Schedule" },
            { key: "lastRun", label: "Last Run" },
            { key: "recent", label: "Recent (S/F/R)" },
          ],
          rows: dags.map((d) => ({
            dagId: d.dagId,
            status: d.isPaused ? "paused" : d.isActive ? "active" : "inactive",
            schedule: formatSchedule(d.schedule),
            lastRun: d.lastRunState ?? "no runs",
            recent: `${d.runSummary.success}/${d.runSummary.failed}/${d.runSummary.running}`,
          })),
        },
      },
    },
    state: {
      selectedDagId: null,
    },
  };
}

function formatSchedule(schedule: unknown): string {
  if (!schedule) return "none";
  if (typeof schedule === "string") return schedule;
  if (typeof schedule === "object" && schedule !== null && "value" in schedule) {
    return (schedule as { value: string }).value;
  }
  return "unknown";
}

export const renderDagOverviewTool = {
  description:
    "Render the DAG overview table on the canvas. Shows all Lattik-managed DAGs with status, schedule, last run result, and recent run summary. This is the starting point for any monitoring workflow. Call this BEFORE writing prose.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => {
    try {
      const dagResult = await airflow.listDags({
        tags: ["lattik"],
        limit: 50,
      });

      // Fetch last few runs for each DAG to build the summary
      const dagsWithRuns = await Promise.all(
        dagResult.dags.map(async (dag) => {
          let lastRunState: string | null = null;
          const runSummary = { success: 0, failed: 0, running: 0 };

          try {
            const runs = await airflow.listDagRuns(dag.dag_id, {
              limit: 10,
              orderBy: "-start_date",
            });
            if (runs.dag_runs.length > 0) {
              lastRunState = runs.dag_runs[0].state;
            }
            for (const r of runs.dag_runs) {
              if (r.state === "success") runSummary.success++;
              else if (r.state === "failed") runSummary.failed++;
              else if (r.state === "running") runSummary.running++;
            }
          } catch {
            // If we can't fetch runs, show the DAG anyway
          }

          return {
            dagId: dag.dag_id,
            description: dag.description,
            isPaused: dag.is_paused,
            isActive: dag.is_active,
            schedule: dag.schedule_interval,
            lastRunState,
            runSummary,
          };
        })
      );

      const spec = buildDagOverviewSpec(dagsWithRuns);

      return {
        kind: "dag_overview",
        spec,
        instruction: RENDER_INSTRUCTION,
      };
    } catch (err) {
      return {
        error: `Failed to render DAG overview: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
