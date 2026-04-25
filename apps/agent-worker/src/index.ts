/**
 * Worker Node main loop — Planner + Executor branches (Phase C.3).
 *
 * Each tick:
 *   1. Try claimRequest (pending → planning). If got one → run Planner.
 *   2. Otherwise try claimTask (any pending task globally). If got one → run Executor.
 *   3. Sleep, repeat.
 *
 * The plan's "one Request per worker" rule was relaxed for the Executor
 * branch — workers claim tasks globally rather than locking parent requests,
 * which lets multiple workers parallelize across an approved request's tasks.
 *
 * Heartbeat: every poll touches an authenticated endpoint, which updates
 * worker.last_seen_at server-side. Empty polls (204) still count.
 */

import { apiFetch } from "./runtime.js";
import { buildPlannerAgent } from "./agents/planner.js";
import { buildExecutorAgent } from "./agents/executor.js";
import { runAgent } from "./agents/run-agent.js";

const POLL_INTERVAL_MS = parseInt(
  process.env.POLL_INTERVAL_MS ?? "5000",
  10,
);

interface ClaimedRequest {
  id: string;
  source: "webhook" | "human";
  description: string;
  context: unknown;
  skill_id: string | null;
  claimed_by: string | null;
  status: string;
  stale_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ClaimedTask {
  id: string;
  request_id: string;
  skill_id: string;
  description: string;
  done_criteria: string;
  status: string;
  claimed_by: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  stale_at: string | null;
  completed_at: string | null;
}

async function claimRequest(): Promise<ClaimedRequest | null> {
  return apiFetch<ClaimedRequest | null>("/api/tasks/requests/claim", {
    method: "POST",
    body: {},
  });
}

async function claimAnyTask(): Promise<ClaimedTask | null> {
  return apiFetch<ClaimedTask | null>("/api/tasks/claim", {
    method: "POST",
    body: {},
  });
}

async function failRequest(id: string, reason: string): Promise<void> {
  try {
    await apiFetch(`/api/tasks/requests/${id}/fail`, {
      method: "POST",
      body: { error: reason },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[planner] could not mark request ${id} failed: ${msg}`);
  }
}

async function failTask(id: string, error: string): Promise<void> {
  try {
    await apiFetch(`/api/tasks/${id}/fail`, {
      method: "POST",
      body: { error },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] could not mark task ${id} failed: ${msg}`);
  }
}

function buildPlannerPrompt(req: ClaimedRequest): string {
  const ctxStr =
    req.context === null || req.context === undefined
      ? "(none)"
      : JSON.stringify(req.context, null, 2);
  return `A new Request needs planning.

ID: ${req.id}
Source: ${req.source}
Description: ${req.description}

Context:
${ctxStr}

Call list_skills, emit_task for each piece of work the Executor should do, then finish_planning.`;
}

async function runPlannerFor(request: ClaimedRequest): Promise<void> {
  console.log(`[planner] claimed request ${request.id} (${request.source})`);
  const agent = buildPlannerAgent({ requestId: request.id });
  try {
    const result = await runAgent(agent, {
      prompt: buildPlannerPrompt(request),
    });
    console.log(
      `[planner] request ${request.id} planned in ${result.steps} steps (finish: ${result.finishReason})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[planner] request ${request.id} crashed: ${msg}`);
    await failRequest(request.id, `planner crashed: ${msg}`);
  }
}

async function runExecutorFor(task: ClaimedTask): Promise<void> {
  console.log(
    `[executor] claimed task ${task.id} (skill: ${task.skill_id})`,
  );
  let built;
  try {
    built = buildExecutorAgent({
      taskId: task.id,
      skillId: task.skill_id,
      description: task.description,
      doneCriteria: task.done_criteria,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] task ${task.id} build failed: ${msg}`);
    await failTask(task.id, `build failed: ${msg}`);
    return;
  }

  try {
    const result = await runAgent(built.agent, { prompt: built.prompt });
    console.log(
      `[executor] task ${task.id} ran in ${result.steps} steps (finish: ${result.finishReason})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] task ${task.id} crashed: ${msg}`);
    await failTask(task.id, `executor crashed: ${msg}`);
  }
}

async function pollOnce() {
  const request = await claimRequest();
  if (request) {
    await runPlannerFor(request);
    return;
  }
  const task = await claimAnyTask();
  if (task) {
    await runExecutorFor(task);
  }
}

async function main() {
  console.log(
    `Worker Node started — Planner + Executor branches live. Polling every ${POLL_INTERVAL_MS}ms.`,
  );

  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Poll error:", msg);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
