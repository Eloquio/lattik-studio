/**
 * Agent-id mapping shared by the chat transport.
 *
 * The web UI keys things on kebab-case extensionIds (`pipeline-manager`,
 * `data-architect`, `data-analyst`); agent-service's workflow loop keys
 * things on PascalCase AgentIds (`PipelineManager`, `DataArchitect`,
 * `DataAnalyst`, `Assistant`). The Assistant has no kebab equivalent —
 * a null extensionId in the UI means "talk to the concierge."
 *
 * The handoff tool's `handedOffTo` output is in PascalCase (it's the
 * agent-service AgentId), so post-handoff the chat-panel needs to
 * normalize back to kebab-case before assigning to its
 * `activeExtensionId` ref. Forgetting this normalization was the bug
 * that broke the canvas registry lookup during the workflow cutover.
 */

export type AgentId =
  | "Assistant"
  | "PipelineManager"
  | "DataArchitect"
  | "DataAnalyst";

/** Map UI extensionId to workflow AgentId. Null/undefined → Assistant. */
export function extensionIdToAgentId(extensionId: string | null): AgentId {
  switch (extensionId) {
    case "pipeline-manager":
      return "PipelineManager";
    case "data-architect":
      return "DataArchitect";
    case "data-analyst":
      return "DataAnalyst";
    default:
      return "Assistant";
  }
}

/** Inverse — used at the handoff seam when `handedOffTo` arrives in
 *  PascalCase from agent-service. Unknown values pass through unchanged
 *  so future agent ids don't silently get clobbered. */
export function agentIdToExtensionId(agentId: string): string {
  switch (agentId) {
    case "PipelineManager":
      return "pipeline-manager";
    case "DataArchitect":
      return "data-architect";
    case "DataAnalyst":
      return "data-analyst";
    default:
      return agentId;
  }
}
