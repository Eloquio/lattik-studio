import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import * as airflow from "../lib/airflow-client";

const RENDER_INSTRUCTION =
  "The DAG overview is now on the canvas. Do NOT repeat the DAG list in chat. Acknowledge briefly (one sentence) and wait for the user to ask about a specific DAG or click a row.";

interface DagData {
  dagId: string;
  description: string | null;
  isPaused: boolean;
  isActive: boolean;
  schedule: unknown;
  lastRunState: string | null;
  recentRunStates: string[];
}

function buildDagOverviewSpec(dags: DagData[]): Spec {
  const activeCount = dags.filter((d) => !d.isPaused && d.isActive).length;
  const pausedCount = dags.filter((d) => d.isPaused).length;

  const dagCards = dags.map((d, i) => `dag-${i}`);

  const elements: Record<string, unknown> = {
    main: {
      type: "Section",
      props: {},
      children: ["header", ...dagCards],
    },
    header: {
      type: "OverviewHeader",
      props: {
        dagCount: dags.length,
        activeCount,
        pausedCount,
      },
    },
  };

  for (let i = 0; i < dags.length; i++) {
    const d = dags[i];
    elements[`dag-${i}`] = {
      type: "DagCard",
      props: {
        dagId: d.dagId,
        description: d.description ?? "",
        status: d.isPaused ? "paused" : d.isActive ? "active" : "inactive",
        schedule: formatSchedule(d.schedule),
        lastRunState: d.lastRunState ?? "no runs",
        recentRuns:
          d.recentRunStates.length > 0
            ? d.recentRunStates
            : ["none"],
      },
    };
  }

  return {
    root: "main",
    elements,
    state: { selectedDagId: null },
  } as Spec;
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
    "Render the DAG overview on the canvas. Shows all Lattik-managed DAGs as cards with status badges, schedule, last run result, and visual run history. This is the starting point for any monitoring workflow. Call this BEFORE writing prose.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => {
    try {
      const dagResult = await airflow.listDags({
        tags: ["lattik"],
        limit: 50,
      });

      const dagsWithRuns = await Promise.all(
        dagResult.dags.map(async (dag) => {
          let lastRunState: string | null = null;
          const recentRunStates: string[] = [];

          try {
            const runs = await airflow.listDagRuns(dag.dag_id, {
              limit: 10,
              orderBy: "-start_date",
            });
            if (runs.dag_runs.length > 0) {
              lastRunState = runs.dag_runs[0].state;
            }
            for (const r of runs.dag_runs) {
              recentRunStates.push(r.state);
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
            recentRunStates,
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
