/**
 * Agent worker — polls the task queue and dispatches to registered agents.
 *
 * No agents are registered yet. The worker still runs: every poll
 * touches /api/tasks/claim so its `last_seen_at` keeps ticking, and the
 * studio Workers page can show it as live. When a task is claimed the
 * worker fails it with a clear "no handler" error so an operator knows
 * to either register an agent here or route the task elsewhere.
 */

import {
  claimTask,
  completeTask,
  failTask,
  type Task,
} from "./task-client.js";

const POLL_INTERVAL_MS = parseInt(
  process.env.POLL_INTERVAL_MS ?? "5000",
  10,
);

/**
 * Map from agent id to the function that runs a task for that agent.
 * Empty for now — historically held a `kafka` entry; add entries here as
 * new agents come online.
 */
type AgentHandler = (task: Task) => Promise<unknown>;
const agentHandlers: Record<string, AgentHandler> = {};

async function executeTask(task: Task) {
  const handler = agentHandlers[task.agent_id];
  if (!handler) {
    const message = `No handler registered for agent "${task.agent_id}"`;
    console.warn(`[${task.agent_id}] ${message} — failing task ${task.id}`);
    await failTask(task.id, message);
    return;
  }

  console.log(
    `[${task.agent_id}] Executing task ${task.id}: ${task.description}`,
  );

  try {
    const result = await handler(task);
    await completeTask(task.id, result);
    console.log(`[${task.agent_id}] Task ${task.id} completed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${task.agent_id}] Task ${task.id} failed:`, message);
    await failTask(task.id, message);
  }
}

async function pollOnce() {
  // Always issue at least one claim call per tick — even with zero
  // registered agents it drives the heartbeat. If handlers grow, iterate
  // over their keys and claim per-agent so multi-agent workers fairly
  // round-robin.
  const agentIds = Object.keys(agentHandlers);
  if (agentIds.length === 0) {
    await claimTask();
    return;
  }
  for (const agentId of agentIds) {
    const task = await claimTask(agentId);
    if (task) {
      await executeTask(task);
    }
  }
}

async function main() {
  const registered = Object.keys(agentHandlers);
  console.log(
    `Agent worker started. Polling every ${POLL_INTERVAL_MS}ms. ` +
      (registered.length === 0
        ? "No agents registered — heartbeat only."
        : `Agents: ${registered.join(", ")}`),
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
