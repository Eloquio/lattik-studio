import type { Spec } from "@json-render/core";
import type {
  DagRunDetailIntent,
  TaskInstanceSummary,
} from "@eloquio/render-intents";

/**
 * Project a DagRunDetailIntent into the json-render Spec the existing
 * Pipeline Manager canvas registry already understands. Element types
 * (`Section`, `RunDetailHeader`, `TaskRow`) match what apps/web's
 * canvas component map already registers.
 */
export function dagRunDetailToSpec(intent: DagRunDetailIntent): Spec {
  const { dagId, runId, logicalDate, runState, startDate, endDate, tasks } =
    intent.data;
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
        logicalDate: logicalDate ?? "unknown",
        state: runState ?? "unknown",
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
      },
    },
  };

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    elements[`task-${i}`] = {
      type: "TaskRow",
      props: taskRowProps(t),
    };
  }

  return {
    root: "main",
    elements,
    state: {
      dagId,
      dagRunId: runId,
      selectedTaskId: null,
    },
  } as Spec;
}

function taskRowProps(t: TaskInstanceSummary): Record<string, unknown> {
  return {
    taskId: t.taskId,
    taskType: inferTaskType(t.taskId, t.operator),
    state: t.state ?? "pending",
    duration: t.durationSeconds !== null ? formatDuration(t.durationSeconds) : "—",
    tryNumber: t.tryNumber,
  };
}

function inferTaskType(
  taskId: string,
  operator: string | null,
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
