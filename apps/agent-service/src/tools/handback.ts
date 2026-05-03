import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * `handback` — chat-runtime-shared lifecycle tool used by every Specialist
 * agent to return control to the Assistant. The tool itself has no side
 * effects; the agent runtime interprets the returned object to either
 * pause the active task or close it out.
 *
 * Lives in `apps/agent-service/src/tools/` rather than `packages/agent-harness`
 * because the response shape is chat-runtime-specific (worker agents don't
 * have a paused-task stack).
 */

export interface CreateHandbackToolOptions {
  /** Agent that owns this handback instance — embedded into the response. */
  fromAgent: string;
}

export function createHandbackTool(opts: CreateHandbackToolOptions) {
  return tool({
    description:
      "Hand control away from this agent. Use type 'pause' when the user wants to work on something else (off-topic). Use type 'complete' when the current task is finished and the user has confirmed they don't need more help.",
    inputSchema: zodSchema(
      z.object({
        type: z
          .enum(["pause", "complete"])
          .describe("'pause' = user detour, 'complete' = task done"),
        reason: z
          .string()
          .describe("Brief description of why control is being transferred"),
      }),
    ),
    execute: async (input: { type: "pause" | "complete"; reason: string }) => ({
      handoffType: input.type,
      reason: input.reason,
      fromAgent: opts.fromAgent,
    }),
  });
}
