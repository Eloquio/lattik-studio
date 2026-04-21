/**
 * Per-task context exposed to agent code. Carries the capability grant
 * chosen by the planner (or the skill recipe for webhook-driven tasks) and
 * provides the guard helper that every resource-access library should call.
 *
 * Dev-mode enforcement is runtime-only: the worker pod has full network
 * access, and a buggy agent can technically bypass these checks by calling
 * `fetch` directly. Prod-mode adds a per-pod egress proxy + NetworkPolicy
 * so the network layer refuses traffic that the capability list doesn't
 * allow — no data model change is needed when we layer that on.
 */
import type { Task } from "./task-client";

export class MissingCapabilityError extends Error {
  constructor(public readonly required: string, public readonly granted: string[]) {
    super(
      `Capability "${required}" is not granted to this task. ` +
        `Granted: [${granted.join(", ") || "none"}].`,
    );
    this.name = "MissingCapabilityError";
  }
}

export interface AgentContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilities: readonly string[];
  /**
   * Assert that the running task was granted `capability`. Throws
   * MissingCapabilityError if not — agent code should not try to catch this;
   * letting it propagate marks the task as failed and surfaces the mismatch.
   */
  requireCapability(capability: string): void;
}

export function createAgentContext(task: Task): AgentContext {
  const granted = task.capabilities ?? [];
  const set = new Set(granted);
  return {
    taskId: task.id,
    agentId: task.agent_id,
    capabilities: granted,
    requireCapability(capability: string) {
      if (!set.has(capability)) {
        throw new MissingCapabilityError(capability, granted);
      }
    },
  };
}
