/**
 * `finish_planning` — close out the planning step for a request.
 *
 * Default outcome is "completed" — the endpoint inspects the inserted run
 * statuses to decide between auto-approve and human-approval. Pass
 * `outcome: "failed"` (with a reason) when no skill matches the request and
 * the planner gives up.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { apiFetch } from "../runtime.js";

export interface FinishPlanningContext {
  requestId: string;
}

export function createFinishPlanningTool(ctx: FinishPlanningContext) {
  return tool({
    description:
      "Close planning for the current request. Use 'completed' (default) after emitting at least one run; the runtime auto-approves or routes to human approval based on the emitted skills' auto_approve flags. Use 'failed' with a reason when no skill matches.",
    inputSchema: zodSchema(
      z.object({
        outcome: z
          .enum(["completed", "failed"])
          .optional()
          .describe("'completed' (default) closes planning; 'failed' aborts"),
        reason: z
          .string()
          .max(2000)
          .optional()
          .describe("Reason — required when outcome is 'failed'"),
      }),
    ),
    execute: async (input: {
      outcome?: "completed" | "failed";
      reason?: string;
    }) => {
      try {
        const result = await apiFetch<{ status: string }>(
          `/api/runs/requests/${ctx.requestId}/finish-planning`,
          {
            method: "POST",
            body: {
              outcome: input.outcome ?? "completed",
              reason: input.reason,
            },
          },
        );
        return {
          requestStatus: result?.status,
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
