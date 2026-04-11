/**
 * Agent worker — polls the task queue and dispatches to specialized agents.
 *
 * Each agent is a cheap LLM (Haiku) with focused tools.
 * The worker claims tasks, runs the agent, and reports results via HTTP.
 */

import { claimTask, completeTask, failTask, type Task } from "./task-client.js";
import { createKafkaAgent } from "./agents/kafka.js";

const POLL_INTERVAL_MS = parseInt(
  process.env.POLL_INTERVAL_MS ?? "5000",
  10
);

const AGENTS = ["kafka"] as const;
type AgentId = (typeof AGENTS)[number];

function createAgent(agentId: AgentId, task: Task) {
  switch (agentId) {
    case "kafka":
      return createKafkaAgent({
        description: task.description,
        doneCriteria: task.done_criteria,
      });
  }
}

async function executeTask(task: Task) {
  const agentId = task.agent_id as AgentId;
  if (!AGENTS.includes(agentId)) {
    await failTask(task.id, `Unknown agent: ${task.agent_id}`);
    return;
  }

  console.log(`[${agentId}] Executing task ${task.id}: ${task.description}`);

  const agent = createAgent(agentId, task);

  try {
    const result = await agent.generate({
      prompt: `Execute this task and verify the done criteria.\n\nTask: ${task.description}\nDone Criteria: ${task.done_criteria}`,
    });

    await completeTask(task.id, { agentResponse: result.text });
    console.log(`[${agentId}] Task ${task.id} completed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${agentId}] Task ${task.id} failed:`, message);
    await failTask(task.id, message);
  }
}

async function pollOnce() {
  for (const agentId of AGENTS) {
    const task = await claimTask(agentId, `agent-worker-${agentId}`);
    if (task) {
      await executeTask(task);
    }
  }
}

async function main() {
  console.log(
    `Agent worker started. Polling every ${POLL_INTERVAL_MS}ms for: ${AGENTS.join(", ")}`
  );

  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error("Poll error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
