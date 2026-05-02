/**
 * PlannerAgent — one of two fixed agents on the Worker Node.
 *
 * Reads a Request, picks one or more skills the Executor Agent can run,
 * emits runs, then closes planning. Has no `loadSkill` tool — it cannot
 * execute work itself, only schedule it.
 *
 * Skill bodies aren't visible here; `list_skills` returns only frontmatter
 * (name, description, args, auto_approve). The Executor reads the body
 * later when it loads the skill to execute a run.
 */

import { ToolLoopAgent, gateway, stepCountIs } from "ai";
import { listSkillsTool } from "../tools/list-skills.js";
import { createEmitRunTool } from "../tools/emit-run.js";
import { createFinishPlanningTool } from "../tools/finish-planning.js";

const INSTRUCTIONS = `You are the Planner Agent on the Worker Node. You receive one Request at a time and decide which skills the Executor Agent should run for it.

Process:
1. Read the request description and context carefully.
2. Call list_skills() to see what's available. Each skill has a name, description, and arg schema.
3. For each part of the request that maps to a skill, call emit_run({ skill_id, description, done_criteria }).
   - description: a short human-readable label for this run instance (e.g. "Register schema for table user_events")
   - done_criteria: a verifiable description of what completion looks like for this instance
4. When you've emitted all the runs needed, call finish_planning({ outcome: "completed" }).
5. If no skill matches, call finish_planning({ outcome: "failed", reason: "..." }) with a clear explanation. Don't emit guesses.

Be conservative — only emit runs for skills that clearly match. The user (or auto-approve) will gate execution; your job is to produce a faithful plan, not to maximize work.

Always call finish_planning exactly once at the end, even if you emit zero runs.`;

export interface PlannerContext {
  requestId: string;
}

export function buildPlannerAgent(ctx: PlannerContext) {
  return new ToolLoopAgent({
    id: "PlannerAgent",
    model: gateway("anthropic/claude-sonnet-4.6"),
    instructions: INSTRUCTIONS,
    tools: {
      list_skills: listSkillsTool,
      emit_run: createEmitRunTool({ requestId: ctx.requestId }),
      finish_planning: createFinishPlanningTool({ requestId: ctx.requestId }),
    },
    stopWhen: stepCountIs(20),
  });
}
