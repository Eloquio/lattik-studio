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
 * wires them (chat tools and worker/skill tools both live in
 * apps/agent-service after the agent-worker deprecation).
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
 * Tool ids registered in the skill-run runtime (`apps/agent-service`'s
 * `runSkillWorkflow`). Loaded by ExecutorAgent. Names match the
 * `tools:` lists in `packages/agent-harness/skills/<id>/SKILL.md`.
 */
export const WORKER_TOOLS: ReadonlySet<string> = new Set([
  "create_kafka_topic",
  "emit_logger_proto",
  "register_protobuf_schema",
  "create_iceberg_table",
  "start_logger_writer",
  "loadSkill",
  "finishSkill",
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
