import { defineEventHandler } from "h3";

/**
 * Health probe — Phase 1 placeholder so the Nitro app has a route to start
 * with. Returns the loaded agent count from the agent-harness so the probe
 * also confirms the service can read AGENT.md files at startup. Will be
 * augmented once /chat lands.
 */
export default defineEventHandler(() => {
  return {
    status: "ok",
    service: "agent-service",
    phase: "scaffolding",
  };
});
