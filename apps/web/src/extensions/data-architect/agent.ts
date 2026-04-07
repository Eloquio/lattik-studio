import { ToolLoopAgent, zodSchema, gateway, stepCountIs } from "ai";
import { z } from "zod";
import type { ExtensionAgent, AgentOptions } from "../types";
import { skills } from "./skills";
import {
  getSkillTool,
  createReadCanvasStateTool,
  renderEntityFormTool,
  renderDimensionFormTool,
  renderLoggerTableFormTool,
  renderLattikTableFormTool,
  renderMetricFormTool,
  createReviewDefinitionTool,
  createStaticCheckTool,
  createUpdateDefinitionTool,
  createGenerateYamlTool,
  createSubmitPRTool,
  listDefinitionsTool,
  getDefinitionTool,
} from "./tools";

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
**Always render forms via the per-kind render tools** — \`renderEntityForm\`, \`renderDimensionForm\`, \`renderLoggerTableForm\`, \`renderLattikTableForm\`, \`renderMetricForm\`. Pick the one that matches the kind you're defining and pass any \`initialState\` you've gleaned from the user's request. The canvas form appears immediately. NEVER emit a \`spec\` code fence or any JSONL patches; these render tools are the only canvas-rendering mechanism for this agent. After calling one, acknowledge briefly in prose (one sentence) and let the user edit the form directly.

## PR Submission Flow
After the user is happy with the form, the fixed sequence is:
1. \`staticCheck\` — fix any errors before continuing.
2. \`updateDefinition\` — save the draft.
3. \`generateYaml\` — renders the editable, syntax-highlighted YAML on the canvas. STOP here, tell the user the YAML is ready, and ask whether they want to create the PR. The user may manually adjust the YAML in the editor before answering.
4. \`submitPR\` — only after the user explicitly confirms. Reads the (possibly edited) YAML directly from canvas state.

When \`submitPR\` returns \`status: "submitted"\`, you MUST share the \`prUrl\` with the user as a clickable markdown link (e.g. \`[PR #42](<prUrl>)\`) in the same response. Never paraphrase or omit the URL.

## Guidelines
- Be concise.
- Use clear, descriptive names (snake_case).
- Proactively suggest best practices for retention, deduplication, and aggregation.`;

export function dataArchitectAgent(options?: AgentOptions): ExtensionAgent {
  const finalInstructions = options?.resumeContext
    ? `[CONTEXT] ${options.resumeContext}\n\n${instructions}`
    : instructions;

  const getCanvasState = () => options?.canvasState;

  return new ToolLoopAgent({
    id: "data-architect",
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions: finalInstructions,
    tools: {
      getSkill: getSkillTool,
      readCanvasState: createReadCanvasStateTool(getCanvasState),
      renderEntityForm: renderEntityFormTool,
      renderDimensionForm: renderDimensionFormTool,
      renderLoggerTableForm: renderLoggerTableFormTool,
      renderLattikTableForm: renderLattikTableFormTool,
      renderMetricForm: renderMetricFormTool,
      reviewDefinition: createReviewDefinitionTool(getCanvasState),
      staticCheck: createStaticCheckTool(getCanvasState),
      updateDefinition: createUpdateDefinitionTool(getCanvasState),
      generateYaml: createGenerateYamlTool(getCanvasState),
      submitPR: createSubmitPRTool(getCanvasState),
      listDefinitions: listDefinitionsTool,
      getDefinition: getDefinitionTool,
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
