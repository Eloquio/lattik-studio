import type { ToolSet } from "ai";
import type { ComponentType } from "react";

export type ExtensionId = string;

export interface ExtensionAgent {
  id: ExtensionId;
  name: string;
  systemPrompt: string;
  tools: ToolSet;
  modelId?: string;
}

export interface ExtensionMeta {
  id: ExtensionId;
  name: string;
  description: string;
  icon: string;
}

export interface ExtensionDefinition extends ExtensionMeta {
  agent: () => ExtensionAgent;
  canvas: ComponentType<{ state: unknown }>;
}
