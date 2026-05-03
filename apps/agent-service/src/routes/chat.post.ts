import { defineEventHandler, readValidatedBody, createError } from "h3";
import { z } from "zod";
import {
  ToolLoopAgent,
  createAgentUIStreamResponse,
  gateway,
  stepCountIs,
  type UIMessage,
} from "ai";
import {
  assertBaseToolsResolve,
  parseAgents,
  renderInstructions,
  createGetSkillTool,
  type AgentId,
} from "@eloquio/agent-harness";
import { AGENT_MANIFEST } from "../agents/agents.generated.js";
import { createHandbackTool } from "../tools/handback.js";
import { createHandoffTool } from "../tools/handoff.js";
import { createReadCanvasStateTool } from "../tools/read-canvas-state.js";
import { listDagsTool } from "../agents/PipelineManager/tools/list-dags.js";
import { getDagDetailTool } from "../agents/PipelineManager/tools/get-dag-detail.js";
import { listDagRunsTool } from "../agents/PipelineManager/tools/list-dag-runs.js";
import { getTaskInstancesTool } from "../agents/PipelineManager/tools/get-task-instances.js";
import { getTaskLogsTool } from "../agents/PipelineManager/tools/get-task-logs.js";
import { renderDagOverviewTool } from "../agents/PipelineManager/tools/render-dag-overview.js";
import { renderDagRunDetailTool } from "../agents/PipelineManager/tools/render-dag-run-detail.js";
import {
  renderEntityFormTool,
  renderDimensionFormTool,
  renderLoggerTableFormTool,
  renderLattikTableFormTool,
  renderMetricFormTool,
} from "../agents/DataArchitect/tools/render-forms.js";
import {
  reviewDefinitionTool,
  createStaticCheckTool,
  createUpdateDefinitionTool,
  createGenerateYamlTool,
  listDefinitionsTool,
  getDefinitionTool,
} from "../agents/DataArchitect/tools/definition-flow.js";
import { createSubmitPRTool } from "../agents/DataArchitect/tools/submit-pr.js";
import { deleteDefinitionTool } from "../agents/DataArchitect/tools/delete-definition.js";
import {
  listTablesTool,
  describeTableTool,
  runQueryTool,
} from "../agents/DataAnalyst/tools/data-tools.js";
import {
  renderSqlEditorTool,
  renderChartTool,
  updateLayoutTool,
} from "../agents/DataAnalyst/tools/render-tools.js";

/**
 * /chat — Phase 1 streaming execution.
 *
 * Loads the requested agent from the embedded AGENT.md manifest, builds a
 * ToolLoopAgent with the runtime-bound tool registry (handback +
 * readCanvasState are chat-runtime-shared; the rest are Pipeline-Manager-
 * owned stubs), and streams the run via `createAgentUIStreamResponse` in
 * the AI SDK's UI Message Stream format — directly consumable by the
 * `useChat` hook on the web client.
 *
 * Runtime credentials for the AI Gateway: on Vercel deployments the AI
 * Gateway integration auto-issues an OIDC token; locally, run
 * `vercel env pull` to mirror that setup. The gateway() factory picks up
 * the token automatically. Missing credentials produce a clear
 * authentication error from the gateway.
 *
 * Conversation persistence (UI message history loaded from the shared
 * conversations table) and Vercel Workflow integration land in subsequent
 * slices. Today every request is a fresh single-turn stream.
 */

const AGENTS = parseAgents(AGENT_MANIFEST);

const taskStackEntrySchema = z.object({
  extensionId: z.string().min(1),
  reason: z.string(),
  // Optional fields the existing web client sends; we accept the wire
  // shape but agent-service uses only extensionId + reason.
  canvasState: z.unknown().optional(),
  pausedAt: z.string().optional(),
});

/**
 * /chat request shape — matches the body the web's `DefaultChatTransport`
 * sends through useChat. agent-service is the ultimate consumer, so the
 * schema mirrors what the AI SDK chat hook produces verbatim:
 *
 *   - `messages` — full UIMessage[] history (opaque to validation; the
 *     AI SDK trusts the shape end-to-end since both sides are typed).
 *   - `extensionId` — kebab-case specialist id (`pipeline-manager`,
 *     `data-architect`, `data-analyst`), or null/undefined when talking
 *     to the Assistant concierge. Web's chat-panel maintains this from
 *     the active task / handoff state.
 *   - `canvasState` — current canvas state, passed through to whichever
 *     agent is built so its readCanvasState tool can return it.
 *   - `taskStack` — paused-task stack (depth-1 today). Used by the
 *     Assistant's handoff tool to enforce the depth cap and by its
 *     {{taskStack}} prompt seam.
 *   - `resumeContext` — short text describing prior context when
 *     resuming a paused agent. Maps to the {{resumeContext}} seam.
 */
const chatRequestSchema = z.object({
  messages: z.array(z.unknown()),
  extensionId: z.string().nullable().optional(),
  canvasState: z.unknown().optional(),
  taskStack: z.array(taskStackEntrySchema).optional(),
  resumeContext: z.string().optional(),
});

/**
 * Map the web's kebab-case extensionId to the canonical PascalCase
 * AgentId. Null / undefined extensionId means "talk to the Assistant"
 * (the concierge that routes incoming messages to specialists).
 *
 * Throws a structured 400 if an unknown extensionId arrives — that's a
 * web/agent-service contract drift the caller should notice.
 */
const EXTENSION_TO_AGENT: Record<string, AgentId> = {
  "pipeline-manager": "PipelineManager",
  "data-architect": "DataArchitect",
  "data-analyst": "DataAnalyst",
};

function resolveAgentId(extensionId: string | null | undefined): AgentId {
  if (extensionId === null || extensionId === undefined || extensionId === "") {
    return "Assistant";
  }
  const id = EXTENSION_TO_AGENT[extensionId];
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown extension "${extensionId}". Supported: ${Object.keys(EXTENSION_TO_AGENT).join(", ")}, or omit for the Assistant.`,
    });
  }
  return id;
}

// Per-agent tool registries. Today only Pipeline Manager exists; new agents
// will append their entries here as their AGENT.md migrations land. The
// inline literal at construction time is deliberate — assigning to a const
// triggers exponential type instantiation (see planner.ts comment in the
// agent-worker).
interface BuildOpts {
  canvasState: unknown;
  resumeContext?: string;
}

function buildPipelineManagerAgent(opts: BuildOpts) {
  const agent = AGENTS.get("PipelineManager");
  if (!agent) {
    throw createError({
      statusCode: 500,
      statusMessage: "PipelineManager AGENT.md missing from manifest",
    });
  }

  const tools = {
    getSkill: createGetSkillTool({ caller: "PipelineManager" }),
    readCanvasState: createReadCanvasStateTool({ getCanvasState: () => opts.canvasState }),
    listDags: listDagsTool,
    getDagDetail: getDagDetailTool,
    listDagRuns: listDagRunsTool,
    getTaskInstances: getTaskInstancesTool,
    getTaskLogs: getTaskLogsTool,
    renderDagOverview: renderDagOverviewTool,
    renderDagRunDetail: renderDagRunDetailTool,
    handback: createHandbackTool({ fromAgent: "PipelineManager" }),
  };

  // Names-only preflight (see comments in apps/agent-worker planner.ts for
  // the rationale).
  assertBaseToolsResolve(agent, [
    "getSkill",
    "readCanvasState",
    "listDags",
    "getDagDetail",
    "listDagRuns",
    "getTaskInstances",
    "getTaskLogs",
    "renderDagOverview",
    "renderDagRunDetail",
    "handback",
  ]);

  return new ToolLoopAgent({
    id: agent.frontmatter.id,
    model: gateway(agent.frontmatter.model),
    instructions: renderInstructions(agent.body, {
      skills: "(none yet)",
      resumeContext: opts.resumeContext,
    }),
    tools: {
      getSkill: tools.getSkill,
      readCanvasState: tools.readCanvasState,
      listDags: tools.listDags,
      getDagDetail: tools.getDagDetail,
      listDagRuns: tools.listDagRuns,
      getTaskInstances: tools.getTaskInstances,
      getTaskLogs: tools.getTaskLogs,
      renderDagOverview: tools.renderDagOverview,
      renderDagRunDetail: tools.renderDagRunDetail,
      handback: tools.handback,
    },
    stopWhen: stepCountIs(agent.frontmatter.max_steps),
  });
}

function buildDataArchitectAgent(opts: BuildOpts & { userId: string }) {
  const agent = AGENTS.get("DataArchitect");
  if (!agent) {
    throw createError({
      statusCode: 500,
      statusMessage: "DataArchitect AGENT.md missing from manifest",
    });
  }

  // Names-only preflight, same pattern as PipelineManager.
  assertBaseToolsResolve(agent, [
    "getSkill",
    "readCanvasState",
    "renderEntityForm",
    "renderDimensionForm",
    "renderLoggerTableForm",
    "renderLattikTableForm",
    "renderMetricForm",
    "reviewDefinition",
    "staticCheck",
    "updateDefinition",
    "generateYaml",
    "submitPR",
    "deleteDefinition",
    "listDefinitions",
    "getDefinition",
    "handback",
  ]);

  return new ToolLoopAgent({
    id: agent.frontmatter.id,
    model: gateway(agent.frontmatter.model),
    instructions: renderInstructions(agent.body, {
      skills: "(none yet)",
      resumeContext: opts.resumeContext,
    }),
    tools: {
      getSkill: createGetSkillTool({ caller: "DataArchitect" }),
      readCanvasState: createReadCanvasStateTool({ getCanvasState: () => opts.canvasState }),
      renderEntityForm: renderEntityFormTool,
      renderDimensionForm: renderDimensionFormTool,
      renderLoggerTableForm: renderLoggerTableFormTool,
      renderLattikTableForm: renderLattikTableFormTool,
      renderMetricForm: renderMetricFormTool,
      reviewDefinition: reviewDefinitionTool,
      staticCheck: createStaticCheckTool({ getCanvasState: () => opts.canvasState }),
      updateDefinition: createUpdateDefinitionTool({
        userId: opts.userId,
        getCanvasState: () => opts.canvasState,
      }),
      generateYaml: createGenerateYamlTool({ getCanvasState: () => opts.canvasState }),
      submitPR: createSubmitPRTool({ getCanvasState: () => opts.canvasState }),
      deleteDefinition: deleteDefinitionTool,
      listDefinitions: listDefinitionsTool,
      getDefinition: getDefinitionTool,
      handback: createHandbackTool({ fromAgent: "DataArchitect" }),
    },
    stopWhen: stepCountIs(agent.frontmatter.max_steps),
  });
}

function buildDataAnalystAgent(opts: BuildOpts) {
  const agent = AGENTS.get("DataAnalyst");
  if (!agent) {
    throw createError({
      statusCode: 500,
      statusMessage: "DataAnalyst AGENT.md missing from manifest",
    });
  }

  assertBaseToolsResolve(agent, [
    "getSkill",
    "listTables",
    "describeTable",
    "renderSqlEditor",
    "runQuery",
    "renderChart",
    "readCanvasState",
    "updateLayout",
    "listDefinitions",
    "getDefinition",
    "handback",
  ]);

  return new ToolLoopAgent({
    id: agent.frontmatter.id,
    model: gateway(agent.frontmatter.model),
    instructions: renderInstructions(agent.body, {
      skills: "(none yet)",
      resumeContext: opts.resumeContext,
    }),
    tools: {
      getSkill: createGetSkillTool({ caller: "DataAnalyst" }),
      listTables: listTablesTool,
      describeTable: describeTableTool,
      renderSqlEditor: renderSqlEditorTool,
      runQuery: runQueryTool,
      renderChart: renderChartTool,
      readCanvasState: createReadCanvasStateTool({ getCanvasState: () => opts.canvasState }),
      updateLayout: updateLayoutTool,
      // listDefinitions / getDefinition are conceptually shared between
      // DataArchitect and DataAnalyst (DA reads definitions for context-aware
      // queries). For now both agents reuse the DataArchitect-side stubs;
      // the real implementations would live in a shared
      // apps/agent-service/src/tools/definitions/ tier when migrated.
      listDefinitions: listDefinitionsTool,
      getDefinition: getDefinitionTool,
      handback: createHandbackTool({ fromAgent: "DataAnalyst" }),
    },
    stopWhen: stepCountIs(agent.frontmatter.max_steps),
  });
}

function buildAssistantAgent(taskStack: { extensionId: string; reason: string }[]) {
  const agent = AGENTS.get("Assistant");
  if (!agent) {
    throw createError({
      statusCode: 500,
      statusMessage: "Assistant AGENT.md missing from manifest",
    });
  }

  assertBaseToolsResolve(agent, ["handoff"]);

  // Build the dynamic-context strings the Assistant's prompt expects.
  // {{specialists}} becomes the registered list (everything except the
  // Assistant itself). {{taskStack}} becomes a paused-task reminder
  // block, or empty when nothing is paused.
  const specialists = [...AGENTS.values()]
    .filter((a) => a.frontmatter.id !== "Assistant")
    .map((a) => `- **${a.frontmatter.name}** (id: "${a.frontmatter.id}"): ${a.frontmatter.description}`)
    .join("\n");

  const top = taskStack.length > 0 ? taskStack[taskStack.length - 1] : null;
  const taskStackText = top
    ? `\n## Paused Task\nThere is a paused task on the stack: the "${top.extensionId}" agent was working on "${sanitizeForPrompt(top.reason)}" and is waiting to resume.\n- Do NOT hand off to a different specialist — handle the user's new request yourself.\n- When the user indicates they are done with their current request ("that's all", "nothing else", "I'm done", etc.), use the handoff tool to resume the paused agent (agentId: "${top.extensionId}") so it can continue where it left off.\n- Briefly tell the user you're handing them back to the paused agent.`
    : "";

  return new ToolLoopAgent({
    id: agent.frontmatter.id,
    model: gateway(agent.frontmatter.model),
    instructions: renderInstructions(agent.body, {
      specialists: specialists || "No specialist agents are registered.",
      taskStack: taskStackText,
    }),
    tools: {
      handoff: createHandoffTool({ taskStack }),
    },
    stopWhen: stepCountIs(agent.frontmatter.max_steps),
  });
}

/**
 * Defense-in-depth: the paused-task `reason` arrives in a user-controlled
 * request payload, then lands in the Assistant's system prompt. Strip
 * structural characters that could be used to inject prompt directives
 * or close out the system message.
 */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/```/g, "''")
    .slice(0, 500);
}


export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  if (!auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }

  const body = await readValidatedBody(event, (data) =>
    chatRequestSchema.safeParse(data),
  );
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid chat request: ${body.error.message}`,
    });
  }

  const {
    messages: rawMessages,
    extensionId,
    canvasState,
    taskStack,
    resumeContext,
  } = body.data;
  const agentId = resolveAgentId(extensionId);
  const uiMessages = rawMessages as UIMessage[];

  // Branching on agentId so each call site sees one concrete ToolLoopAgent
  // generic — TS can't unify the union of agents with different tool sets.
  if (agentId === "Assistant") {
    return createAgentUIStreamResponse({
      agent: buildAssistantAgent(taskStack ?? []),
      uiMessages,
    });
  }
  if (agentId === "DataArchitect") {
    return createAgentUIStreamResponse({
      agent: buildDataArchitectAgent({
        canvasState,
        userId: auth.userId,
        resumeContext,
      }),
      uiMessages,
    });
  }
  if (agentId === "DataAnalyst") {
    return createAgentUIStreamResponse({
      agent: buildDataAnalystAgent({ canvasState, resumeContext }),
      uiMessages,
    });
  }
  return createAgentUIStreamResponse({
    agent: buildPipelineManagerAgent({ canvasState, resumeContext }),
    uiMessages,
  });
});
