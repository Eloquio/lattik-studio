/**
 * ExecutorAgent — built per task on the Worker Node.
 *
 * The runtime pre-loads `task.skill_id` (validating the skill's
 * `owners.includes("ExecutorAgent")`) and constructs a one-shot agent whose
 * instructions are the skill body and whose tools are the skill's declared
 * `tools:` plus `finishSkill`. The LLM follows the runbook and calls
 * `finishSkill` exactly once when complete.
 *
 * `loadSkill` as an LLM tool is deferred — see PLAN-skill-based-worker-loop.md.
 */

import { ToolLoopAgent, gateway, stepCountIs, type Tool } from "ai";
import { getSkill } from "@eloquio/lattik-skills";
import { createFinishSkillTool } from "../tools/finish-skill.js";
import { getStubTool, isStubTool } from "../tools/skill-stubs.js";

export interface ExecutorTaskInput {
  taskId: string;
  skillId: string;
  description: string;
  doneCriteria: string;
}

export interface ExecutorBuildResult {
  agent: ToolLoopAgent<never, Record<string, Tool>>;
  prompt: string;
}

/**
 * Build an Executor agent for a specific task. Resolves the skill, validates
 * ownership, wires the tool set, returns the agent + a prompt the caller
 * passes to runAgent.
 *
 * Throws if the skill isn't found or doesn't list ExecutorAgent in owners.
 * The caller should fail the task with the thrown reason.
 */
export function buildExecutorAgent(
  task: ExecutorTaskInput,
): ExecutorBuildResult {
  const skill = getSkill(task.skillId, "ExecutorAgent");

  // Wire each declared tool. Skip silently if it's not a known stub —
  // the loader's preflight already warns about unrecognised ids; here we
  // just don't pass them to the agent so the LLM can't call something that
  // isn't there.
  const tools: Record<string, Tool> = {};
  for (const toolId of skill.frontmatter.tools) {
    if (isStubTool(toolId)) {
      tools[toolId] = getStubTool(toolId);
    } else {
      console.warn(
        `[executor] skill "${task.skillId}" declares unregistered tool "${toolId}" — dropping`,
      );
    }
  }
  tools.finishSkill = createFinishSkillTool({
    taskId: task.taskId,
    doneChecks: skill.frontmatter.done,
  });

  const agent = new ToolLoopAgent({
    id: `Executor:${task.skillId}`,
    model: gateway("anthropic/claude-sonnet-4.6"),
    instructions: skill.body,
    tools,
    stopWhen: stepCountIs(20),
  });

  const prompt = `Task ${task.taskId}.

Description: ${task.description}

Done when: ${task.doneCriteria}

Follow the runbook in your instructions, use the tools available to you, and call finishSkill exactly once when complete.`;

  return { agent, prompt };
}
