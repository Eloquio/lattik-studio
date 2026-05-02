/**
 * `emit_run` — insert a run for the Executor Agent to pick up.
 *
 * Inserts at status `pending` if the skill is auto_approve, `draft` otherwise.
 * That decision is mechanical (no LLM judgment): the skill's frontmatter
 * declares its approval policy, and `finish_planning` later inspects the
 * resulting statuses to decide whether the request lands at `approved` or
 * `awaiting_approval`.
 *
 * Returns either the inserted run or a structured error so the LLM can
 * recover (e.g. retry with a different skill_id).
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { getSkill } from "@eloquio/agent-harness";
import { apiFetch } from "../runtime.js";

export interface EmitRunContext {
  /**
   * The id of the request the planner is currently working on. Bound when
   * `runAgent(PlannerAgent, ...)` constructs the tool, so the LLM can't
   * spoof a different requestId.
   */
  requestId: string;
}

export function createEmitRunTool(ctx: EmitRunContext) {
  return tool({
    description:
      "Insert one run for the Executor Agent to execute. The skill_id must be returned by list_skills(). The runtime sets run status from the skill's auto_approve flag — no need to specify it.",
    inputSchema: zodSchema(
      z.object({
        skill_id: z
          .string()
          .min(1)
          .describe("Skill id from list_skills()"),
        description: z
          .string()
          .min(1)
          .max(4000)
          .describe("Short, human-readable description of this run"),
        done_criteria: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "Verifiable description of what 'done' means for this run instance",
          ),
      }),
    ),
    execute: async (input: {
      skill_id: string;
      description: string;
      done_criteria: string;
    }) => {
      // Look up the skill so we can read auto_approve. Owners check is
      // enforced by getSkill — the planner only schedules ExecutorAgent
      // skills, so any skill that isn't listed there can't be emitted.
      let skill;
      try {
        skill = getSkill(input.skill_id, "ExecutorAgent");
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const status = skill.frontmatter.auto_approve ? "pending" : "draft";

      try {
        const run = await apiFetch<{ id: string }>("/api/runs", {
          method: "POST",
          body: {
            requestId: ctx.requestId,
            skillId: input.skill_id,
            description: input.description,
            doneCriteria: input.done_criteria,
            status,
          },
        });
        return {
          runId: run?.id,
          skillId: input.skill_id,
          status,
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
