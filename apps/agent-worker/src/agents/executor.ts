/**
 * ExecutorAgent — built per run on the Worker Node.
 *
 * The runtime pre-loads `run.skill_id` (validating the skill's
 * `owners.includes("ExecutorAgent")`) and constructs a one-shot agent whose
 * instructions are the skill body and whose tools are the skill's declared
 * `tools:` plus `finishSkill`. The LLM follows the runbook and calls
 * `finishSkill` exactly once when complete.
 *
 * Model is read from the skill's frontmatter (default Haiku); skills that
 * need more judgment can override with Sonnet.
 */

import {
  ToolLoopAgent,
  gateway,
  stepCountIs,
  type Tool,
  type OnStepFinishEvent,
  type OnFinishEvent,
} from "ai";
import { getSkill } from "@eloquio/agent-harness";
import { createFinishSkillTool } from "../tools/finish-skill.js";
import { getTool } from "../tools/registry.js";

export interface RunMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
}

export interface ExecutorRunInput {
  runId: string;
  skillId: string;
  description: string;
  doneCriteria: string;
  args: Record<string, unknown> | null;
  onStep?: (step: OnStepFinishEvent) => Promise<void> | void;
  onFinish?: (event: OnFinishEvent, metrics: RunMetrics) => Promise<void> | void;
}

export interface ExecutorBuildResult {
  agent: ToolLoopAgent<never, Record<string, Tool>>;
  prompt: string;
  model: string;
}

/**
 * Build an Executor agent for a specific run. Resolves the skill, validates
 * ownership, wires the tool set, returns the agent + a prompt the caller
 * passes to runAgent.
 *
 * Throws if the skill isn't found or doesn't list ExecutorAgent in owners.
 * The caller should fail the run with the thrown reason.
 */
export function buildExecutorAgent(
  run: ExecutorRunInput,
): ExecutorBuildResult {
  const skill = getSkill(run.skillId, "ExecutorAgent");

  // Wire each declared tool from the registry. Skip any name we don't know
  // about (loader preflight already warns); the LLM simply won't have access
  // to a tool that isn't there.
  const tools: Record<string, Tool> = {};
  for (const toolName of skill.frontmatter.tools) {
    const t = getTool(toolName);
    if (t) {
      tools[toolName] = t;
    } else {
      console.warn(
        `[executor] skill "${run.skillId}" declares unregistered tool "${toolName}" — dropping`,
      );
    }
  }
  tools.finishSkill = createFinishSkillTool({
    runId: run.runId,
    doneChecks: skill.frontmatter.done,
  });

  const model = skill.frontmatter.model;
  const agent = new ToolLoopAgent({
    id: `Executor:${run.skillId}`,
    model: gateway(model),
    instructions: skill.body,
    tools,
    stopWhen: stepCountIs(20),
    ...(run.onStep ? { onStepFinish: run.onStep } : {}),
    ...(run.onFinish
      ? {
          onFinish: async (event: OnFinishEvent) => {
            const metrics: RunMetrics = {
              model,
              inputTokens: event.totalUsage?.inputTokens ?? 0,
              outputTokens: event.totalUsage?.outputTokens ?? 0,
              toolCallCount: event.steps.reduce(
                (n, s) => n + (s.toolCalls?.length ?? 0),
                0,
              ),
            };
            await run.onFinish!(event, metrics);
          },
        }
      : {}),
  });

  const argsBlock =
    run.args && Object.keys(run.args).length > 0
      ? `\n\nArgs (pass these to tool calls):\n${JSON.stringify(run.args, null, 2)}`
      : "";

  const prompt = `Run ${run.runId}.

Description: ${run.description}

Done when: ${run.doneCriteria}${argsBlock}

Follow the runbook in your instructions, use the tools available to you, and call finishSkill exactly once when complete.`;

  return { agent, prompt, model };
}
