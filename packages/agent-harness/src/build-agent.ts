/**
 * Helpers for instantiating an agent from a loaded AGENT.md.
 *
 * Consumers construct the `ToolLoopAgent` themselves — passing the tool
 * literal directly to its constructor lets TypeScript bind the constructor's
 * generic `TOOLS` parameter to the inferred record type. Wrapping the
 * constructor in a non-generic factory forces TS to widen each tool's type
 * to fit `ToolSet`'s union, which causes exponential type instantiation in
 * the consumer (`tsc --noEmit` OOMs at 4 GB). Workaround: keep the
 * substitution helper here, let the consumer call `new ToolLoopAgent`.
 */

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
 * Verify that every name in `base_tools` is present in the provided tool
 * name set. Throws listing any unknowns plus what was available.
 *
 * Takes just the **names** (not the actual ToolSet) deliberately: the
 * caller's tool literal must be passed directly to `new ToolLoopAgent`
 * without first being widened to `ToolSet` — that widening triggers
 * exponential type instantiation (`tsc --noEmit` OOMs at 4 GB). Naming the
 * tools redundantly here is the cheap workaround.
 */
export function assertBaseToolsResolve(
  agent: Agent,
  toolNames: ReadonlySet<string> | readonly string[],
): void {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const missing: string[] = [];
  for (const name of agent.frontmatter.base_tools) {
    if (!names.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    const available = [...names].sort().join(", ") || "(none)";
    throw new Error(
      `Agent "${agent.frontmatter.id}" references unknown tools: ${missing.join(", ")}. Available: ${available}`,
    );
  }
}
