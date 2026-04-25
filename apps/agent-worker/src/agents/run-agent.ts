/**
 * Headless agent runner.
 *
 * Wraps `ToolLoopAgent.generate(...)` with logging + error capture. Each
 * agent module exports a builder `buildXxxAgent(ctx)` that returns the
 * configured `ToolLoopAgent`; this file just runs whatever it's given.
 *
 * Phase C.3 will extend this with the loadSkill grant/revoke lifecycle —
 * for now the runner is a thin pass-through that surfaces tool errors via
 * the AI SDK's normal flow.
 */

import type { ToolLoopAgent } from "ai";

export interface RunAgentResult {
  text: string;
  finishReason: string;
  steps: number;
}

// CALL_OPTIONS=never makes the `options` arg optional on .generate(...).
// The TOOLS / OUTPUT generics are intentionally loose — the runner doesn't
// touch their internals, only invokes the agent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolLoopAgent = ToolLoopAgent<never, any, any>;

export async function runAgent(
  agent: AnyToolLoopAgent,
  options: { prompt: string },
): Promise<RunAgentResult> {
  const result = await agent.generate({ prompt: options.prompt });
  return {
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
  };
}
