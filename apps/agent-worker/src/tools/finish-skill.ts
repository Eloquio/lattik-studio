/**
 * `finishSkill` — close out the loaded skill for a run.
 *
 * Runs the skill's `done[]` checks. If all pass, marks the run `done` via
 * /api/runs/:id/complete. If any fail, marks the run `failed` with the
 * first failure's reason — programmatic verification disagreed with the
 * runbook's claim of completion, so the work isn't actually done.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import type { DoneCheck } from "@eloquio/lattik-skills";
import { apiFetch } from "../runtime.js";
import { runDoneChecks } from "../done-checks.js";

export interface FinishSkillContext {
  runId: string;
  doneChecks: DoneCheck[];
}

export function createFinishSkillTool(ctx: FinishSkillContext) {
  return tool({
    description:
      "Call exactly once when the skill's runbook is complete. Pass `status: \"failed\"` if any tool returned `ok: false` or the work could not be completed; otherwise omit `status` (defaults to \"done\"). The runtime additionally runs the skill's `done[]` checks before marking the run done — any failed check downgrades the result to failed.",
    inputSchema: zodSchema(
      z.object({
        result: z
          .string()
          .max(2000)
          .describe(
            "Short summary of what the runbook accomplished. When status is failed, summarize which tools failed and why.",
          ),
        status: z
          .enum(["done", "failed"])
          .optional()
          .describe(
            "Set to \"failed\" if any tool returned ok: false or the work could not complete. Default \"done\".",
          ),
      }),
    ),
    execute: async (input: { result: string; status?: "done" | "failed" }) => {
      // LLM said failed — honor it without bothering with done[] checks.
      if (input.status === "failed") {
        try {
          await apiFetch(`/api/runs/${ctx.runId}/fail`, {
            method: "POST",
            body: { error: input.result },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `failRun call failed: ${msg}; original failure: ${input.result}` };
        }
        return { runStatus: "failed", error: input.result };
      }

      // LLM said done — verify with done[] checks before marking complete.
      const failure = await runDoneChecks(ctx.doneChecks);
      if (failure) {
        const error = `done check #${failure.index} (${failure.kind}) failed: ${failure.reason}`;
        try {
          await apiFetch(`/api/runs/${ctx.runId}/fail`, {
            method: "POST",
            body: { error },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `failRun call failed: ${msg}; original failure: ${error}` };
        }
        return { runStatus: "failed", error };
      }

      try {
        await apiFetch(`/api/runs/${ctx.runId}/complete`, {
          method: "POST",
          body: { result: input.result },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `completeRun call failed: ${msg}` };
      }
      return { runStatus: "done", result: input.result };
    },
  });
}
