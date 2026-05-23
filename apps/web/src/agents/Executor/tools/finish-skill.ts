/**
 * `finishSkill` — close out the loaded skill for a run.
 *
 * Runs the skill's `done[]` checks. Returns a structured payload the
 * workflow can pick up via `agent.generate()`'s last tool call. Unlike
 * the agent-worker version (`apps/agent-worker/src/tools/finish-skill.ts`),
 * this does NOT POST back to apps/web's run-queue endpoints — the
 * workflow itself is the run, and its return value is the result.
 *
 * The agent still calls finishSkill exactly once per the post-merge
 * skill's runbook, even though strictly speaking the workflow could
 * derive completion from the agent's last text. Keeping the explicit
 * call gives the LLM a clear stopping signal and exercises the
 * `done[]` programmatic checks (a safety net against the LLM lying
 * about what it accomplished).
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import type { DoneCheck } from "@eloquio/agent-harness";
import { runDoneChecks } from "../done-checks";

export interface FinishSkillContext {
  runId: string;
  doneChecks: DoneCheck[];
}

export interface FinishSkillResult {
  runStatus: "done" | "failed";
  result?: string;
  error?: string;
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
    execute: async (input: {
      result: string;
      status?: "done" | "failed";
    }): Promise<FinishSkillResult> => {
      void ctx.runId; // Reserved for future per-run logging.

      // LLM said failed — honor it without bothering with done[] checks.
      if (input.status === "failed") {
        return { runStatus: "failed", error: input.result };
      }

      // LLM said done — verify with done[] checks before reporting complete.
      const failure = await runDoneChecks(ctx.doneChecks);
      if (failure) {
        const error = `done check #${failure.index} (${failure.kind}) failed: ${failure.reason}`;
        return { runStatus: "failed", error };
      }

      return { runStatus: "done", result: input.result };
    },
  });
}
