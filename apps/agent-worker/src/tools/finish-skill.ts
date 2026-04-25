/**
 * `finishSkill` — close out the loaded skill for a task.
 *
 * Runs the skill's `done[]` checks. If all pass, marks the task `done` via
 * /api/tasks/:id/complete. If any fail, marks the task `failed` with the
 * first failure's reason — programmatic verification disagreed with the
 * runbook's claim of completion, so the work isn't actually done.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import type { DoneCheck } from "@eloquio/lattik-skills";
import { apiFetch } from "../runtime.js";
import { runDoneChecks } from "../done-checks.js";

export interface FinishSkillContext {
  taskId: string;
  doneChecks: DoneCheck[];
}

export function createFinishSkillTool(ctx: FinishSkillContext) {
  return tool({
    description:
      "Call exactly once when the skill's runbook is complete. The runtime runs the skill's done[] checks and marks the task done (all pass) or failed (any fail). Pass a short result string summarizing what got done.",
    inputSchema: zodSchema(
      z.object({
        result: z
          .string()
          .max(2000)
          .describe("Short summary of what the runbook accomplished"),
      }),
    ),
    execute: async (input: { result: string }) => {
      const failure = await runDoneChecks(ctx.doneChecks);
      if (failure) {
        const error = `done check #${failure.index} (${failure.kind}) failed: ${failure.reason}`;
        try {
          await apiFetch(`/api/tasks/${ctx.taskId}/fail`, {
            method: "POST",
            body: { error },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `failTask call failed: ${msg}; original failure: ${error}` };
        }
        return { taskStatus: "failed", error };
      }

      try {
        await apiFetch(`/api/tasks/${ctx.taskId}/complete`, {
          method: "POST",
          body: { result: input.result },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `completeTask call failed: ${msg}` };
      }
      return { taskStatus: "done", result: input.result };
    },
  });
}
