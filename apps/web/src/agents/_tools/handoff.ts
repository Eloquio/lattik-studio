import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * `handoff` — chat-runtime-shared lifecycle tool used by the Assistant
 * (concierge) to route a user's request to a specialist agent, or to
 * resume a paused specialist from the task stack. The tool itself has
 * no side effects; the chat client (web canvas / Slack adapter / …)
 * interprets the returned object to actually transition.
 *
 * Pairs with `handback` — handback returns control TO the Assistant,
 * handoff routes control AWAY from it. Together they implement the
 * depth-1 task stack from `docs/architecture/agent-handoff.md`.
 */

export interface CreateHandoffToolOptions {
  /** Currently-paused task stack (depth-1; max one entry today). */
  taskStack?: { extensionId: string; reason: string }[];
}

export function createHandoffTool(opts: CreateHandoffToolOptions) {
  const stack = opts.taskStack ?? [];
  return tool({
    description:
      "Hand off the conversation to a specialized agent. Use this when the user's request matches an available agent.",
    inputSchema: zodSchema(
      z.object({
        agentId: z.string().describe("The id of the agent to hand off to"),
        reason: z.string().describe("Brief reason for the handoff"),
      }),
    ),
    execute: async (input: { agentId: string; reason: string }) => {
      // Allow resuming the paused specialist (stack pop) but block new
      // handoffs while a task is paused. depth-1 stack — see the handoff
      // architecture doc.
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      const isPausedResume = top !== null && top.extensionId === input.agentId;
      if (stack.length >= 1 && !isPausedResume) {
        return {
          error:
            "Maximum task depth reached. Handle this request directly or suggest the user finish their paused task.",
        };
      }
      return { handedOffTo: input.agentId, reason: input.reason };
    },
  });
}
