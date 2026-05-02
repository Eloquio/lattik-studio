/**
 * Worker Node main loop — Planner + Executor branches.
 *
 * Each tick:
 *   1. Try claimRequest (pending → planning). If got one → run Planner.
 *   2. Otherwise try claimRun (any pending run globally). If got one → run Executor.
 *   3. Sleep, repeat.
 *
 * Workers claim runs globally rather than locking parent requests, which lets
 * multiple workers parallelize across an approved request's runs.
 *
 * Heartbeat: every poll touches an authenticated endpoint, which updates
 * worker.last_seen_at server-side. Empty polls (204) still count.
 */

import { getSkill } from "@eloquio/lattik-skills";
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

interface ClaimedRun {
  id: string;
  request_id: string;
  skill_id: string;
  description: string;
  done_criteria: string;
  status: string;
  args: Record<string, unknown> | null;
  claimed_by: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  stale_at: string | null;
  completed_at: string | null;
}

async function claimRequest(): Promise<ClaimedRequest | null> {
  return apiFetch<ClaimedRequest | null>("/api/runs/requests/claim", {
    method: "POST",
    body: {},
  });
}

async function claimAnyRun(): Promise<ClaimedRun | null> {
  return apiFetch<ClaimedRun | null>("/api/runs/claim", {
    method: "POST",
    body: {},
  });
}

async function failRequest(id: string, reason: string): Promise<void> {
  try {
    await apiFetch(`/api/runs/requests/${id}/fail`, {
      method: "POST",
      body: { error: reason },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[planner] could not mark request ${id} failed: ${msg}`);
  }
}

interface StepEvent {
  kind: "text" | "reasoning" | "tool_call" | "tool_result" | "finish" | "error";
  payload?: unknown;
}

async function postStepEvents(runId: string, events: StepEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await apiFetch(`/api/runs/${runId}/steps`, {
      method: "POST",
      body: { events },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] could not post steps for run ${runId}: ${msg}`);
  }
}

async function postRunMetrics(
  runId: string,
  metrics: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
  },
): Promise<void> {
  try {
    await apiFetch(`/api/runs/${runId}/metrics`, {
      method: "POST",
      body: {
        model: metrics.model,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        tool_call_count: metrics.toolCallCount,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] could not post metrics for run ${runId}: ${msg}`);
  }
}

// Convert a single AI-SDK step into 1+ persisted step events. Each text /
// reasoning block + tool call + tool result becomes its own row so the UI
// flowchart can render them as separate nodes.
function explodeStep(step: { content?: unknown[]; toolCalls?: unknown[]; toolResults?: unknown[]; finishReason?: string; usage?: unknown }): StepEvent[] {
  const events: StepEvent[] = [];
  for (const block of step.content ?? []) {
    const b = block as { type?: string; text?: string; reasoning?: string };
    if (b.type === "text" && b.text) {
      events.push({ kind: "text", payload: { text: b.text } });
    } else if (b.type === "reasoning" && b.reasoning) {
      events.push({ kind: "reasoning", payload: { text: b.reasoning } });
    }
  }
  for (const call of step.toolCalls ?? []) {
    const c = call as { toolCallId?: string; toolName?: string; input?: unknown };
    events.push({
      kind: "tool_call",
      payload: { toolCallId: c.toolCallId, toolName: c.toolName, input: c.input },
    });
  }
  for (const res of step.toolResults ?? []) {
    const r = res as { toolCallId?: string; toolName?: string; output?: unknown };
    events.push({
      kind: "tool_result",
      payload: { toolCallId: r.toolCallId, toolName: r.toolName, output: r.output },
    });
  }
  events.push({
    kind: "finish",
    payload: { finishReason: step.finishReason, usage: step.usage },
  });
  return events;
}

async function failRun(id: string, error: string): Promise<void> {
  try {
    await apiFetch(`/api/runs/${id}/fail`, {
      method: "POST",
      body: { error },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] could not mark run ${id} failed: ${msg}`);
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

async function runExecutorFor(run: ClaimedRun): Promise<void> {
  console.log(
    `[executor] claimed run ${run.id} (skill: ${run.skill_id})`,
  );

  let built;
  try {
    built = buildExecutorAgent({
      runId: run.id,
      skillId: run.skill_id,
      description: run.description,
      doneCriteria: run.done_criteria,
      args: run.args,
      onStep: async (step) => {
        await postStepEvents(run.id, explodeStep(step));
      },
      onFinish: async (_event, metrics) => {
        await postRunMetrics(run.id, metrics);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] run ${run.id} build failed: ${msg}`);
    await failRun(run.id, `build failed: ${msg}`);
    return;
  }

  try {
    const result = await runAgent(built.agent, { prompt: built.prompt });
    console.log(
      `[executor] run ${run.id} ran in ${result.steps} steps (finish: ${result.finishReason}, model: ${built.model})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] run ${run.id} crashed: ${msg}`);
    await failRun(run.id, `executor crashed: ${msg}`);
  }
}

async function pollOnce() {
  const request = await claimRequest();
  if (request) {
    await runPlannerFor(request);
    return;
  }
  const run = await claimAnyRun();
  if (run) {
    await runExecutorFor(run);
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
