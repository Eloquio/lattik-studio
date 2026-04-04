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

export interface AgentOptions {
  canvasState?: unknown;
}

export interface ExtensionDefinition extends ExtensionMeta {
  agent: (options?: AgentOptions) => ExtensionAgent;
  canvas: ComponentType<{ state: unknown; onStateChange?: (state: Record<string, unknown>) => void }>;
}
