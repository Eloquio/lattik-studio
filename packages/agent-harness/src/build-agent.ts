/**
 * `buildAgent` — turn a loaded AGENT.md into a runnable ToolLoopAgent.
 *
 * Encapsulates the boilerplate that every chat-side `agent.ts` and worker
 * `planner.ts` writes today: substitute the body's template seams, resolve
 * the frontmatter's `base_tools` against a runtime-provided registry,
 * configure the gateway model + step cap, hand back a `ToolLoopAgent`.
 *
 * Consumers construct the tool registry themselves — tools have
 * runtime-bound closures (db handles, request ids, render-intent emitters)
 * that the harness has no business knowing about. The harness's only job
 * is to wire what's given.
 */

import { ToolLoopAgent, gateway, stepCountIs, type Tool } from "ai";
import { type Agent } from "./agent-schema.js";

/** Replace the deliberately-capped template seams in an AGENT.md body. */
export function renderInstructions(
  body: string,
  vars: { skills?: string; resumeContext?: string },
): string {
  const skills = vars.skills ?? "";
  const resume =
    vars.resumeContext && vars.resumeContext.length > 0
      ? `[CONTEXT] ${vars.resumeContext}\n\n`
      : "";
  return body.replaceAll("{{skills}}", skills).replaceAll("{{resumeContext}}", resume);
}

/**
 * Resolve every name in `base_tools` against the provided registry. Throws
 * with the full list of unknowns and what was actually available — the
 * preflight equivalent of TS-level checking now that AGENT.md isn't typed.
 */
export function resolveBaseTools(
  agent: Agent,
  tools: Record<string, Tool>,
): Record<string, Tool> {
  const resolved: Record<string, Tool> = {};
  const missing: string[] = [];
  for (const name of agent.frontmatter.base_tools) {
    const t = tools[name];
    if (t) {
      resolved[name] = t;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    const available = Object.keys(tools).sort().join(", ") || "(none)";
    throw new Error(
      `Agent "${agent.frontmatter.id}" references unknown tools: ${missing.join(", ")}. Available: ${available}`,
    );
  }
  return resolved;
}

export interface BuildAgentOptions {
  agent: Agent;
  /**
   * Tools the runtime has constructed for this agent invocation. Must be a
   * superset of `agent.frontmatter.base_tools` — extras are ignored, missing
   * ones throw at construction time.
   */
  tools: Record<string, Tool>;
  /**
   * Optional template substitutions for the body. Only `{{skills}}` and
   * `{{resumeContext}}` are recognized — anything else stays literal.
   */
  templateVars?: { skills?: string; resumeContext?: string };
}

/**
 * Build a `ToolLoopAgent` from a loaded AGENT.md and a tool registry. The
 * agent's instructions are the substituted body, model + step cap come from
 * frontmatter, and tools are the resolved subset.
 */
export function buildAgent(
  opts: BuildAgentOptions,
): ToolLoopAgent<never, Record<string, Tool>> {
  const tools = resolveBaseTools(opts.agent, opts.tools);
  const instructions = renderInstructions(
    opts.agent.body,
    opts.templateVars ?? {},
  );
  return new ToolLoopAgent({
    id: opts.agent.frontmatter.id,
    model: gateway(opts.agent.frontmatter.model),
    instructions,
    tools,
    stopWhen: stepCountIs(opts.agent.frontmatter.max_steps),
  });
}
