import { ToolLoopAgent, zodSchema, gateway, stepCountIs } from "ai";
import { z } from "zod";
import { pipelineDefinitionSchema } from "./schema";
import type { PipelineDefinition } from "./schema";
import type { ExtensionAgent, AgentOptions } from "../types";
import { skills } from "./skills";
import {
  getSkillTool,
  createReadCanvasStateTool,
  reviewDefinitionTool,
  staticCheckTool,
  updateDefinitionTool,
  submitPRTool,
  listDefinitionsTool,
  getDefinitionTool,
} from "./tools";
import { catalog } from "./canvas/catalog";

const skillList = skills
  .map((s) => `- **${s.id}**: ${s.description}`)
  .join("\n");

const instructions = `You are the Data Architect agent in Lattik Studio. You help users define and manage data pipeline concepts: Entities, Dimensions, Logger Tables, Lattik Tables, and Metrics.

## Available Skills
${skillList}

## How to Work
1. Understand what the user wants to define or modify.
2. Use getSkill to load the appropriate skill document — it contains the full workflow, canvas layout, and validation details for that concept.
3. Follow the steps in the loaded skill document.

Do NOT assume workflow details from memory. Always load the skill first — the skill document is the source of truth.

## Off-Topic Requests
If the user asks about something outside your specialty (data pipeline design):
1. Gently suggest finishing the current task first: "We're in the middle of [current task]. Want to finish this first?"
2. If the user insists or asks again, use the handback tool with type "pause" to let the assistant handle their request.

## Task Completion
When you've finished helping the user with their request, ask: "Is there anything else I can help with?"
- If the user confirms they're done ("that's all", "nothing else", "no thanks", etc.), use the handback tool with type "complete".
- Do NOT auto-complete. Only hand back when the user explicitly confirms.

## Canvas Rendering
When you need to render UI on the canvas (forms, previews, tables), output JSONL patches in a \`\`\`spec code fence. The available components and format are described below.

${catalog.prompt({ mode: "inline" })}

## Guidelines
- Be concise.
- Use clear, descriptive names (snake_case).
- When updating the pipeline, always send the COMPLETE definition.
- Proactively suggest best practices for retention, deduplication, and aggregation.`;

export function dataArchitectAgent(options?: AgentOptions): ExtensionAgent {
  const finalInstructions = options?.resumeContext
    ? `[CONTEXT] ${options.resumeContext}\n\n${instructions}`
    : instructions;

  return new ToolLoopAgent({
    id: "data-architect",
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions: finalInstructions,
    tools: {
      getSkill: getSkillTool,
      readCanvasState: createReadCanvasStateTool(
        () => options?.canvasState
      ),
      reviewDefinition: reviewDefinitionTool,
      staticCheck: staticCheckTool,
      updateDefinition: updateDefinitionTool,
      submitPR: submitPRTool,
      listDefinitions: listDefinitionsTool,
      getDefinition: getDefinitionTool,
      updatePipeline: {
        description:
          "Update the pipeline definition displayed on the canvas. Always send the complete definition.",
        inputSchema: zodSchema(pipelineDefinitionSchema),
        execute: async (pipeline: PipelineDefinition) => pipeline,
      },
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
              .describe("Brief description of why control is being transferred"),
          })
        ),
        execute: async (input: { type: "pause" | "complete"; reason: string }) => ({
          handoffType: input.type,
          reason: input.reason,
          fromAgent: "data-architect",
        }),
      },
    },
    stopWhen: stepCountIs(10),
  });
}
