import type { ExtensionAgent, ExtensionId } from "../types";
import { getExtension } from "../registry";

export function getExtensionAgent(id: ExtensionId): ExtensionAgent | undefined {
  const ext = getExtension(id);
  return ext?.agent();
}
