import { defineHook } from "workflow";

export interface SandboxDoneEvent {
  ok: boolean;
  exitCode: number;
  errorMessage?: string;
  stderrTail?: string;
}

/**
 * Workflow hook the sandbox resumes via `POST /api/internal/sandbox-complete`.
 * One token per (dagRunId, taskId, instanceId) — see `sandboxDoneToken`
 * for why `instanceId` is necessary.
 */
export const sandboxDoneHook = defineHook<SandboxDoneEvent>();

/**
 * Hook tokens are GLOBAL across workflow executions ("releasing its token
 * for reuse by other workflows", per @workflow/core's `Hook.dispose`
 * docs). When dagRunner is re-spawned for the same `dagRunId` (host
 * restart, manual partial-clear), both the old and new instance would
 * otherwise contend on the same `dagRunId:taskId` token. Mixing in a
 * per-workflow-execution `instanceId` isolates them.
 *
 * `instanceId` is generated inside a step in dag-runner.ts, so replays
 * of the same workflow execution see the cached value but a fresh
 * re-spawn produces a new one.
 */
export function sandboxDoneToken(
  dagRunId: string,
  taskId: string,
  instanceId: string
): string {
  return `sandbox-done:${dagRunId}:${instanceId}:${taskId}`;
}
