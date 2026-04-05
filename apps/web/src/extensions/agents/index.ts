import type { ExtensionAgent, ExtensionId, AgentOptions } from "../types";
import { getExtension } from "../registry";

export type { AgentOptions };

export function getExtensionAgent(id: ExtensionId, options?: AgentOptions): ExtensionAgent | undefined {
  const ext = getExtension(id);
  return ext?.agent(options);
}
