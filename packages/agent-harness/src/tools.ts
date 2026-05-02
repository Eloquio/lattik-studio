/**
 * Tool registry — runtime by registration.
 *
 * Each runtime owns its own set of tools. A tool's runtime is "wherever it
 * was registered" — there's no `runtimes:` self-declaration. Skills that
 * reference a tool not in the loading agent's runtime have it dropped
 * silently at agent-instantiation time; the loader's preflight check warns
 * about this at startup so authors notice.
 *
 * These are stub Sets — real handler functions live wherever the runtime
 * wires them (chat tools in the web app, worker tools in apps/agent-worker).
 */

import type { Runtime } from "./agents.js";

/**
 * Tool ids registered in the chat runtime (the Next.js app).
 * Loaded by Assistant + Specialist agents.
 */
export const CHAT_TOOLS: ReadonlySet<string> = new Set([
  "handoff",
  "handback",
  "renderCanvas",
  "loadSkill",
  "finishSkill",
  "getSkill",
]);

/**
 * Tool ids registered in the worker node (apps/agent-worker).
 * Loaded by Planner + Executor agents.
 */
export const WORKER_TOOLS: ReadonlySet<string> = new Set([
  "list_skills",
  "emit_task",
  "finish_planning",
  "loadSkill",
  "finishSkill",
  // Skill-grantable tools — declared here so the preflight knows they're
  // wired on the worker side. Real handlers land alongside the skills that
  // need them.
  "kafka:write",
  "s3:write",
  "trino:query",
  "http:post",
  "sr:register",
]);

const REGISTRIES: Record<Runtime, ReadonlySet<string>> = {
  chat: CHAT_TOOLS,
  worker: WORKER_TOOLS,
};

export function isToolRegistered(runtime: Runtime, toolId: string): boolean {
  return REGISTRIES[runtime].has(toolId);
}

export function toolsForRuntime(runtime: Runtime): ReadonlySet<string> {
  return REGISTRIES[runtime];
}
