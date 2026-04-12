import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import * as airflow from "../lib/airflow-client";

const RENDER_INSTRUCTION =
  "The run detail is now on the canvas showing the task graph with per-task status. Do NOT repeat the task list in chat. Summarize the run state briefly (which tasks succeeded/failed, total duration) and offer to show logs for any failed tasks.";

function buildDagRunDetailSpec(
  dagId: string,
  run: {
    runId: string;
    logicalDate: string;
    state: string;
    startDate: string | null;
    endDate: string | null;
  },
  tasks: Array<{
    taskId: string;
    state: string | null;
    operator: string | null;
    durationSeconds: number | null;
    tryNumber: number;
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
          title: `${dagId}`,
          subtitle: `Run: ${run.logicalDate} \u2014 ${run.state}`,
        },
      },
      table: {
        type: "DataTable",
        props: {
          columns: [
            { key: "taskId", label: "Task" },
            { key: "type", label: "Type" },
            { key: "state", label: "State" },
            { key: "duration", label: "Duration" },
            { key: "tries", label: "Tries" },
          ],
          rows: tasks.map((t) => ({
            taskId: t.taskId,
            type: inferTaskType(t.taskId, t.operator),
            state: t.state ?? "pending",
            duration: t.durationSeconds
              ? formatDuration(t.durationSeconds)
              : "\u2014",
            tries: String(t.tryNumber),
          })),
        },
      },
    },
    state: {
      dagId,
      dagRunId: run.runId,
      selectedTaskId: null,
    },
  };
}

function inferTaskType(taskId: string, operator: string | null): string {
  if (taskId.startsWith("wait__")) return "sensor";
  if (taskId.startsWith("build__")) return "spark";
  if (operator) return operator;
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
    "Render the detail view for a specific DAG run on the canvas. Shows the task graph with per-task status, duration, and try count. Call this after the user selects a run to inspect.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("The Airflow DAG ID"),
      dagRunId: z.string().describe("The DAG run ID to show detail for"),
    })
  ),
  execute: async (input: { dagId: string; dagRunId: string }) => {
    try {
      // Fetch run info and task instances in parallel
      const [runsResult, tasksResult] = await Promise.all([
        airflow.listDagRuns(input.dagId, { limit: 1 }),
        airflow.listTaskInstances(input.dagId, input.dagRunId),
      ]);

      // Find the specific run
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
