/**
 * PlannerAgent — one of two fixed agents on the Worker Node.
 *
 * Reads a Request, picks one or more skills the Executor Agent can run,
 * emits runs, then closes planning. Has no `loadSkill` tool — it cannot
 * execute work itself, only schedule it.
 *
 * The system prompt and frontmatter (model, step cap, base_tools) live in
 * `PlannerAgent/AGENT.md`; this file wires the runtime-bound tools and
 * passes them to `new ToolLoopAgent` directly. The literal must stay
 * inline at the constructor call so the constructor's generic
 * `TOOLS extends ToolSet` parameter binds without widening — assigning
 * the literal to a `const` first triggers a `ToolSet` constraint check
 * that explodes into exponential type instantiation (`tsc --noEmit` OOMs).
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolLoopAgent, gateway, stepCountIs } from "ai";
import {
  assertBaseToolsResolve,
  getAgent,
  renderInstructions,
} from "@eloquio/agent-harness";
import { listSkillsTool } from "../tools/list-skills.js";
import { createEmitRunTool } from "../tools/emit-run.js";
import { createFinishPlanningTool } from "../tools/finish-planning.js";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLANNER_DEF = getAgent("PlannerAgent", { agentsDir: AGENTS_DIR });
const PLANNER_INSTRUCTIONS = renderInstructions(PLANNER_DEF.body, {});

// Names-only preflight — confirms AGENT.md base_tools match the registered
// names below without ever widening the typed tool literal.
const REGISTERED_TOOL_NAMES = ["list_skills", "emit_run", "finish_planning"];
assertBaseToolsResolve(PLANNER_DEF, REGISTERED_TOOL_NAMES);

export interface PlannerContext {
  requestId: string;
}

export function buildPlannerAgent(ctx: PlannerContext) {
  return new ToolLoopAgent({
    id: PLANNER_DEF.frontmatter.id,
    model: gateway(PLANNER_DEF.frontmatter.model),
    instructions: PLANNER_INSTRUCTIONS,
    tools: {
      list_skills: listSkillsTool,
      emit_run: createEmitRunTool({ requestId: ctx.requestId }),
      finish_planning: createFinishPlanningTool({ requestId: ctx.requestId }),
    },
    stopWhen: stepCountIs(PLANNER_DEF.frontmatter.max_steps),
  });
}
