import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import * as airflow from "../lib/airflow-client";

const RENDER_INSTRUCTION =
  "The run detail is now on the canvas showing each task with its status. Do NOT repeat the task list in chat. Summarize the run state briefly (which tasks succeeded/failed, total duration) and offer to show logs for any failed tasks.";

interface TaskData {
  taskId: string;
  state: string | null;
  operator: string | null;
  durationSeconds: number | null;
  tryNumber: number;
}

function buildDagRunDetailSpec(
  dagId: string,
  run: {
    runId: string;
    logicalDate: string;
    state: string;
    startDate: string | null;
    endDate: string | null;
  },
  tasks: TaskData[]
): Spec {
  const taskKeys = tasks.map((_, i) => `task-${i}`);

  const elements: Record<string, unknown> = {
    main: {
      type: "Section",
      props: {},
      children: ["header", ...taskKeys],
    },
    header: {
      type: "RunDetailHeader",
      props: {
        dagId,
        logicalDate: run.logicalDate,
        state: run.state,
        startDate: run.startDate ?? undefined,
        endDate: run.endDate ?? undefined,
      },
    },
  };

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    elements[`task-${i}`] = {
      type: "TaskRow",
      props: {
        taskId: t.taskId,
        taskType: inferTaskType(t.taskId, t.operator),
        state: t.state ?? "pending",
        duration: t.durationSeconds
          ? formatDuration(t.durationSeconds)
          : "\u2014",
        tryNumber: t.tryNumber,
      },
    };
  }

  return {
    root: "main",
    elements,
    state: {
      dagId,
      dagRunId: run.runId,
      selectedTaskId: null,
    },
  } as Spec;
}

function inferTaskType(
  taskId: string,
  operator: string | null
): "sensor" | "spark" | "unknown" {
  if (taskId.startsWith("wait__")) return "sensor";
  if (taskId.startsWith("build__")) return "spark";
  if (operator) return "unknown";
  return "unknown";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

export const renderDagRunDetailTool = {
  description:
    "Render the detail view for a specific DAG run on the canvas. Shows a header with run metadata and each task as a row with status indicator, duration, and type. Call this after the user selects a run to inspect.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("The Airflow DAG ID"),
      dagRunId: z.string().describe("The DAG run ID to show detail for"),
    })
  ),
  execute: async (input: { dagId: string; dagRunId: string }) => {
    try {
      const [runsResult, tasksResult] = await Promise.all([
        airflow.listDagRuns(input.dagId, { limit: 1 }),
        airflow.listTaskInstances(input.dagId, input.dagRunId),
      ]);

      const run = runsResult.dag_runs.find(
        (r) => r.dag_run_id === input.dagRunId
      );

      const runInfo = run
        ? {
            runId: run.dag_run_id,
            logicalDate: run.logical_date,
            state: run.state,
            startDate: run.start_date,
            endDate: run.end_date,
          }
        : {
            runId: input.dagRunId,
            logicalDate: "unknown",
            state: "unknown",
            startDate: null,
            endDate: null,
          };

      const tasks = tasksResult.task_instances.map((t) => ({
        taskId: t.task_id,
        state: t.state,
        operator: t.operator,
        durationSeconds: t.duration ? Math.round(t.duration) : null,
        tryNumber: t.try_number,
      }));

      const spec = buildDagRunDetailSpec(input.dagId, runInfo, tasks);

      return {
        kind: "dag_run_detail",
        spec,
        instruction: RENDER_INSTRUCTION,
      };
    } catch (err) {
      return {
        error: `Failed to render run detail: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
