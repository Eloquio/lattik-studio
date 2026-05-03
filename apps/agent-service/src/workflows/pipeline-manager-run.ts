import { getWritable } from "workflow";
import {
  ToolLoopAgent,
  createAgentUIStream,
  gateway,
  stepCountIs,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  assertBaseToolsResolve,
  parseAgents,
  renderInstructions,
  createGetSkillTool,
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

// Spike 4: wrap the existing Pipeline Manager `ToolLoopAgent` in a workflow
// step so the run becomes durable + reattach-friendly. The whole agent loop
// runs inside ONE step (each tool call is NOT yet its own step), so a worker
// crash mid-loop replays the entire run from the start. Per-tool durability
// is the next refinement.

const AGENTS = parseAgents(AGENT_MANIFEST);

export interface PipelineManagerInput {
  uiMessages: UIMessage[];
  canvasState: unknown;
  resumeContext?: string;
}

async function runPipelineManagerStep(input: PipelineManagerInput) {
  "use step";
  const agentDef = AGENTS.get("PipelineManager");
  if (!agentDef) {
    throw new Error("PipelineManager AGENT.md missing from manifest");
  }

  const tools = {
    getSkill: createGetSkillTool({ caller: "PipelineManager" }),
    readCanvasState: createReadCanvasStateTool({
      getCanvasState: () => input.canvasState,
    }),
    listDags: listDagsTool,
    getDagDetail: getDagDetailTool,
    listDagRuns: listDagRunsTool,
    getTaskInstances: getTaskInstancesTool,
    getTaskLogs: getTaskLogsTool,
    renderDagOverview: renderDagOverviewTool,
    renderDagRunDetail: renderDagRunDetailTool,
    handback: createHandbackTool({ fromAgent: "PipelineManager" }),
  };

  assertBaseToolsResolve(agentDef, [
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

  const agent = new ToolLoopAgent({
    id: agentDef.frontmatter.id,
    model: gateway(agentDef.frontmatter.model),
    instructions: renderInstructions(agentDef.body, {
      skills: "(none yet)",
      resumeContext: input.resumeContext,
    }),
    tools,
    stopWhen: stepCountIs(agentDef.frontmatter.max_steps),
  });

  const uiStream = await createAgentUIStream({
    agent,
    uiMessages: input.uiMessages,
  });

  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  let chunkCount = 0;
  try {
    for await (const chunk of uiStream) {
      chunkCount++;
      await writer.write(chunk);
    }
  } finally {
    await writer.close();
  }
  return { chunkCount };
}

export async function pipelineManagerWorkflow(input: PipelineManagerInput) {
  "use workflow";
  return runPipelineManagerStep(input);
}
