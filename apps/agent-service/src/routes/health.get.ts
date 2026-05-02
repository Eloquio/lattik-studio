import { resolve } from "node:path";
import { defineEventHandler } from "h3";
import { listAgents } from "@eloquio/agent-harness";

// Resolve the agents directory from the dev server's cwd. `nitropack dev`
// runs from `apps/agent-service/`, so `src/agents` is reachable. This works
// for local dev — production deployment will need a different strategy
// (Nitro `serverAssets` storage API, or a bundled-at-build-time manifest)
// once `/chat` lands and actually consumes AGENT.md content at runtime.
const AGENTS_DIR = resolve(process.cwd(), "src/agents");

/**
 * Health probe — returns service status plus the agents the harness can
 * discover under `<src>/agents/`. Doubles as a smoke test that AGENT.md
 * files are readable in this runtime.
 */
export default defineEventHandler(() => {
  const agents = listAgents({ agentsDir: AGENTS_DIR });
  return {
    status: "ok",
    service: "agent-service",
    phase: "scaffolding",
    agents: agents.map((a) => ({
      id: a.frontmatter.id,
      name: a.frontmatter.name,
      model: a.frontmatter.model,
      max_steps: a.frontmatter.max_steps,
      base_tools: a.frontmatter.base_tools,
    })),
  };
});
