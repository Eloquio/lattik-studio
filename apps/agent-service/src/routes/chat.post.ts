import { defineEventHandler, readValidatedBody, createError } from "h3";
import { z } from "zod";
import { ToolLoopAgent, gateway, stepCountIs } from "ai";
import {
  assertBaseToolsResolve,
  parseAgents,
  renderInstructions,
  createGetSkillTool,
  type AgentId,
} from "@eloquio/agent-harness";
import { AGENT_MANIFEST } from "../agents/agents.generated.js";
import { createHandbackTool } from "../tools/handback.js";
import { createReadCanvasStateTool } from "../tools/read-canvas-state.js";
import { listDagsTool } from "../agents/PipelineManager/tools/list-dags.js";
import { getDagDetailTool } from "../agents/PipelineManager/tools/get-dag-detail.js";
import { listDagRunsTool } from "../agents/PipelineManager/tools/list-dag-runs.js";
import { getTaskInstancesTool } from "../agents/PipelineManager/tools/get-task-instances.js";
import { getTaskLogsTool } from "../agents/PipelineManager/tools/get-task-logs.js";
import { renderDagOverviewTool } from "../agents/PipelineManager/tools/render-dag-overview.js";
import { renderDagRunDetailTool } from "../agents/PipelineManager/tools/render-dag-run-detail.js";

/**
 * /chat — Phase 1 synchronous execution.
 *
 * Loads the requested agent from the embedded AGENT.md manifest, builds a
 * ToolLoopAgent with the runtime-bound tool registry (handback +
 * readCanvasState are chat-runtime-shared; the rest are Pipeline-Manager-
 * owned stubs), runs `agent.generate()` with the user message, returns the
 * text result. No SSE, no Workflow, no real Airflow tools yet — those land
 * in subsequent slices.
 *
 * Runtime credentials for the AI Gateway:
 *  - On Vercel deployments, the AI Gateway integration auto-issues an
 *    OIDC token to the function (no manual env var). The gateway()
 *    factory picks it up automatically.
 *  - For local dev, run `vercel env pull` to mirror the production OIDC
 *    setup, or set AI_GATEWAY_API_KEY directly as a fallback.
 * Without credentials, generate() throws a clear "missing credentials"
 * error to the caller — easy to spot.
 */

const AGENTS = parseAgents(AGENT_MANIFEST);

const chatRequestSchema = z.object({
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  message: z.string().min(1),
});

// Per-agent tool registries. Today only Pipeline Manager exists; new agents
// will append their entries here as their AGENT.md migrations land. The
// inline literal at construction time is deliberate — assigning to a const
// triggers exponential type instantiation (see planner.ts comment in the
// agent-worker).
function buildPipelineManagerAgent(canvasState: unknown | null) {
  const agent = AGENTS.get("PipelineManager");
  if (!agent) {
    throw createError({
      statusCode: 500,
      statusMessage: "PipelineManager AGENT.md missing from manifest",
    });
  }

  const tools = {
    getSkill: createGetSkillTool({ caller: "PipelineManager" }),
    readCanvasState: createReadCanvasStateTool({ getCanvasState: () => canvasState }),
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
    instructions: renderInstructions(agent.body, { skills: "(none yet)" }),
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

const SUPPORTED_AGENTS: ReadonlySet<AgentId> = new Set(["PipelineManager"]);

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

  const { agentId, message } = body.data;
  if (!SUPPORTED_AGENTS.has(agentId as AgentId)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown or unsupported agent "${agentId}". Supported: ${[...SUPPORTED_AGENTS].join(", ")}`,
    });
  }

  // Future: load conversation state from packages/db-schema's conversations
  // table by (clientId, conversationId). For now, every call is a fresh
  // single-turn run. SSE + Workflow integration replace this in the next
  // slice.
  const agent = buildPipelineManagerAgent(null);
  const result = await agent.generate({ prompt: message });
  return {
    clientId: auth.clientId,
    userId: auth.userId,
    conversationId: body.data.conversationId,
    agentId,
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
  };
});
