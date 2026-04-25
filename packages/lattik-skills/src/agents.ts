/**
 * Agent identifiers.
 *
 * Every agent definition picks a runtime and is referenced by id from skills'
 * `owners:` field, from `loadSkill` / `list_skills` calls, and from agent
 * definition modules themselves. Adding a new agent: add the id here, add the
 * runtime mapping below, and add the agent definition wherever your runtime
 * registers them.
 */

export type ChatAgentId =
  | "Assistant"
  | "DataArchitect"
  | "DataAnalyst"
  | "PipelineManager";

export type WorkerAgentId = "PlannerAgent" | "ExecutorAgent";

export type AgentId = ChatAgentId | WorkerAgentId;

export type Runtime = "chat" | "worker";

/**
 * Static runtime mapping. Agents are runtime-bound by definition; this is the
 * single source of truth for which runtime each lives in.
 */
export const AGENT_RUNTIME: Record<AgentId, Runtime> = {
  Assistant: "chat",
  DataArchitect: "chat",
  DataAnalyst: "chat",
  PipelineManager: "chat",
  PlannerAgent: "worker",
  ExecutorAgent: "worker",
};

export const ALL_AGENT_IDS: readonly AgentId[] = Object.keys(
  AGENT_RUNTIME,
) as AgentId[];

export function runtimeOf(agent: AgentId): Runtime {
  return AGENT_RUNTIME[agent];
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && value in AGENT_RUNTIME;
}
