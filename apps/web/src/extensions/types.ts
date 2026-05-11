import type { Agent } from "ai";
import type { ComponentType } from "react";
import type { TaskStackEntry } from "@/lib/types/task-stack";

export type ExtensionId = string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExtensionAgent = Agent<any, any, any>;

export interface ExtensionMeta {
  id: ExtensionId;
  name: string;
  description: string;
  icon: string;
}

/**
 * Standard envelope for new extension tool returns. The agent prompts are
 * easier to keep aligned across extensions when every tool follows the same
 * `{ ok, data | error }` shape. Existing per-extension tools (runQuery,
 * staticCheck, getDagDetail, etc.) still use ad-hoc shapes for backward
 * compatibility with their agent prompts; new tools should use this envelope.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function toolOk<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function toolError(error: string): ToolResult<never> {
  return { ok: false, error };
}

/**
 * Minimum shape every extension's skill metadata must satisfy. Extensions
 * can extend this with additional fields (e.g. data-architect adds
 * `audience: "agent" | "reviewer"` to gate reviewer-only docs out of the
 * agent skill menu).
 */
export interface BaseSkillMeta {
  id: string;
  title: string;
  description: string;
  filename: string;
}

export interface AgentOptions {
  canvasState?: unknown;
  taskStack?: TaskStackEntry[];
  resumeContext?: string;
  /**
   * Optional setter for within-turn canvas mutation. Used by data-analyst
   * to thread state across tool calls in the same agent turn (e.g.
   * `runQuery` writes results that a later `renderChart` reads). Extensions
   * that don't need this can leave it undefined.
   */
  setCanvasState?: (spec: unknown) => void;
}

export interface ExtensionDefinition extends ExtensionMeta {
  agent: (options?: AgentOptions) => ExtensionAgent;
  canvas?: ComponentType<{
    spec: import("@json-render/core").Spec | null;
    loading?: boolean;
    onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
    /**
     * Optional handler the canvas component can call to send a follow-up
     * message into the chat on the user's behalf (e.g. a "submit" button on
     * a confirmation panel). Currently only data-architect's canvas uses it;
     * other extensions accept the prop but don't.
     */
    onSendMessage?: (text: string) => void;
  }>;
}
