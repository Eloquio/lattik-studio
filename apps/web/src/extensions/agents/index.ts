import type { ExtensionAgent, ExtensionId } from "../types";
import { getExtension } from "../registry";

export interface AgentOptions {
  canvasState?: unknown;
}

export function getExtensionAgent(id: ExtensionId, options?: AgentOptions): ExtensionAgent | undefined {
  const ext = getExtension(id);
  return ext?.agent(options);
}
