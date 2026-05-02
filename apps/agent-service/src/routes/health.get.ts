import { defineEventHandler } from "h3";
import { parseAgents } from "@eloquio/agent-harness";
import { AGENT_MANIFEST } from "../agents/agents.generated.js";

// Parse the build-time-generated AGENT.md manifest at module load. Errors
// (invalid frontmatter, duplicate ids) crash startup, which is what we want —
// the service shouldn't accept traffic with a broken agent registry.
const AGENTS = parseAgents(AGENT_MANIFEST);

/**
 * Health probe — returns service status plus the agents loaded from the
 * generated manifest. Doubles as a smoke test that the manifest is valid
 * and the harness parses it cleanly.
 */
export default defineEventHandler(() => {
  return {
    status: "ok",
    service: "agent-service",
    phase: "scaffolding",
    agents: [...AGENTS.values()].map((a) => ({
      id: a.frontmatter.id,
      name: a.frontmatter.name,
      model: a.frontmatter.model,
      max_steps: a.frontmatter.max_steps,
      base_tools: a.frontmatter.base_tools,
    })),
  };
});
