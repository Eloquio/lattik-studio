import { ToolLoopAgent, zodSchema, gateway, stepCountIs } from "ai";
import { z } from "zod";
import type { ExtensionAgent, AgentOptions } from "../types";
import { skills } from "./skills";
import {
  getSkillTool,
  createReadCanvasStateTool,
  listDagsTool,
  getDagDetailTool,
  listDagRunsTool,
  getTaskInstancesTool,
  getTaskLogsTool,
  renderDagOverviewTool,
  renderDagRunDetailTool,
} from "./tools";

const skillList = skills
  .map((s) => `- **${s.id}**: ${s.description}`)
  .join("\n");

const instructions = `You are the Pipeline Manager agent in Lattik Studio. You are the data-ecosystem reliability specialist: you make sure data is flowing end-to-end across the platform's two operational surfaces:

- **Logger Tables** — event ingestion through Kafka into Iceberg, written by the logger-writer pipeline.
- **Airflow DAGs** — materialization of Lattik Tables on top of Logger Tables (and on top of other Lattik Tables).

You help users monitor, troubleshoot, and operate both surfaces. The Data Architect defines what the data ecosystem looks like; you keep it running.

## Available Skills
${skillList}

## How to Work
1. Understand what the user wants to do — check overall health, investigate a Logger Table, monitor DAGs, debug a failure, trigger a run, etc.
2. Use getSkill to load the appropriate skill document — it contains the full workflow for that task.
3. Follow the steps in the loaded skill document.

Do NOT assume workflow details from memory. Always load the skill first — the skill document is the source of truth.

## Canvas Rendering
**For DAG monitoring or overview requests, your FIRST tool call after \`getSkill\` MUST be \`renderDagOverview\`.** When the user asks about a specific run, call \`renderDagRunDetail\` to show the task graph. Do NOT ask clarifying questions first — the canvas IS the starting point for these flows.

NEVER emit a \`spec\` code fence or any JSONL patches — the render tools are the only canvas-rendering mechanism for this agent. After calling one, acknowledge briefly in prose (one sentence) and let the user interact with the canvas.

## Off-Topic Requests
If the user asks about something outside your specialty (data-ecosystem monitoring and operations — Logger Tables and Airflow DAGs):
1. Gently suggest finishing the current task first: "We're in the middle of [current task]. Want to finish this first?"
2. If the user insists or asks again, use the handback tool with type "pause" to let the assistant handle their request.

## Task Completion
When you've finished helping the user with their request, ask: "Is there anything else I can help with?"
- If the user confirms they're done ("that's all", "nothing else", "no thanks", etc.), use the handback tool with type "complete".
- Do NOT auto-complete. Only hand back when the user explicitly confirms.

## Guidelines
- Be concise.
- When showing DAG or run info, prefer the canvas over long chat messages.
- For failed tasks, proactively offer to show logs.
- Only Lattik-managed surfaces are in scope: DAGs tagged \`lattik\` and Logger Tables registered through the platform. If the user asks about unrelated DAGs or external data systems, explain they're outside this agent's scope.`;

export function pipelineManagerAgent(
  options?: AgentOptions
): ExtensionAgent {
  const finalInstructions = options?.resumeContext
    ? `[CONTEXT] ${options.resumeContext}\n\n${instructions}`
    : instructions;

  const getCanvasState = () => options?.canvasState;

  return new ToolLoopAgent({
    id: "pipeline-manager",
    model: gateway("anthropic/claude-sonnet-4.6"),
    instructions: finalInstructions,
    tools: {
      getSkill: getSkillTool,
      readCanvasState: createReadCanvasStateTool(getCanvasState),
      listDags: listDagsTool,
      getDagDetail: getDagDetailTool,
      listDagRuns: listDagRunsTool,
      getTaskInstances: getTaskInstancesTool,
      getTaskLogs: getTaskLogsTool,
      renderDagOverview: renderDagOverviewTool,
      renderDagRunDetail: renderDagRunDetailTool,
      handback: {
        description:
          "Hand control away from this agent. Use type 'pause' when the user wants to work on something else (off-topic). Use type 'complete' when the current task is finished and the user has confirmed they don't need more help.",
        inputSchema: zodSchema(
          z.object({
            type: z
              .enum(["pause", "complete"])
              .describe("'pause' = user detour, 'complete' = task done"),
            reason: z
              .string()
              .describe(
                "Brief description of why control is being transferred"
              ),
          })
        ),
        execute: async (input: {
          type: "pause" | "complete";
          reason: string;
        }) => ({
          handoffType: input.type,
          reason: input.reason,
          fromAgent: "pipeline-manager",
        }),
      },
    },
    stopWhen: stepCountIs(10),
  });
}
