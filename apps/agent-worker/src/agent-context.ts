/**
 * Per-task context exposed to agent code. Skills receive this alongside
 * the claimed Task and use it to resolve identity + (eventually) pass
 * configuration through to their tool implementations.
 *
 * Kept minimal by design — when we need richer per-task state, extend
 * the AgentContext shape, not the Task row.
 */
import type { Task } from "./task-client";

export interface AgentContext {
  readonly taskId: string;
  readonly agentId: string;
}

export function createAgentContext(task: Task): AgentContext {
  return {
    taskId: task.id,
    agentId: task.agent_id,
  };
}
