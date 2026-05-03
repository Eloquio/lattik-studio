import { defineEventHandler } from "h3";
import { start } from "workflow/api";

// Spike: smoke-test a workflow with one step. Verifies that the
// `workflow/nitro` module registers cleanly with nitropack@2 + that
// the `'use workflow'` / `'use step'` directives transform without
// error.

async function helloStep(name: string) {
  "use step";
  return `hello ${name} at ${new Date().toISOString()}`;
}

async function helloWorkflow(name: string) {
  "use workflow";
  const greeting = await helloStep(name);
  return { greeting };
}

export default defineEventHandler(async () => {
  const run = await start(helloWorkflow, ["spike"]);
  // Wait for the run to complete so we can return a smoke-test result.
  // (Real callers fire-and-forget — Spike 2 will demonstrate streaming.)
  const greeting = await run.returnValue;
  return { runId: run.runId, greeting };
});
