import type { Agent } from "ai";
import type { ComponentType } from "react";

export type ExtensionId = string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExtensionAgent = Agent<any, any, any>;

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
