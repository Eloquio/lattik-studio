import { getWritable } from "workflow";
import {
  streamText,
  gateway,
  tool,
  zodSchema,
  convertToModelMessages,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { z } from "zod";

// PipelineManager tools (pure)
import { listDagsTool } from "../agents/PipelineManager/tools/list-dags.js";
import { getDagDetailTool } from "../agents/PipelineManager/tools/get-dag-detail.js";
import { listDagRunsTool } from "../agents/PipelineManager/tools/list-dag-runs.js";
import { getTaskInstancesTool } from "../agents/PipelineManager/tools/get-task-instances.js";
import { getTaskLogsTool } from "../agents/PipelineManager/tools/get-task-logs.js";
import { renderDagOverviewTool } from "../agents/PipelineManager/tools/render-dag-overview.js";
import { renderDagRunDetailTool } from "../agents/PipelineManager/tools/render-dag-run-detail.js";

// DataArchitect tools.
import {
  renderEntityFormTool,
  renderDimensionFormTool,
  renderLoggerTableFormTool,
  renderLattikTableFormTool,
  renderMetricFormTool,
} from "../agents/DataArchitect/tools/render-forms.js";
import {
  listDefinitionsTool,
  getDefinitionTool,
  createStaticCheckTool,
  createUpdateDefinitionTool,
  createGenerateYamlTool,
} from "../agents/DataArchitect/tools/definition-flow.js";
import { createSubmitPRTool } from "../agents/DataArchitect/tools/submit-pr.js";
import { deleteDefinitionTool } from "../agents/DataArchitect/tools/delete-definition.js";

// DataAnalyst tools (all pure)
import {
  listTablesTool,
  describeTableTool,
  runQueryTool,
} from "../agents/DataAnalyst/tools/data-tools.js";
import { renderSqlEditorTool } from "../agents/DataAnalyst/tools/render-tools.js";

// Assistant (concierge) — handoff is its only tool.
import { createHandoffTool } from "../tools/handoff.js";

// Conversation persistence
import { eq } from "drizzle-orm";
import { conversations } from "@eloquio/db-schema";
import { getDb } from "../lib/db.js";

// Spike: generalized per-tool-durable agent loop. Same architecture as
// `pipeline-manager-loop.ts` (workflow body drives the loop, every model
// call and tool call is its own step), but parameterized over agent
// identity so DataArchitect and DataAnalyst can run through the same
// orchestrator. Per-request context (canvasState, userId) flows as
// workflow input rather than via closures, so it survives the
// workflow→step serialization boundary.
//
// Scope is deliberately a representative slice of each agent's tool
// surface — enough to prove the factory dispatch pattern works under
// per-tool durability. Wiring the remaining tools is mechanical
// (registry entries) and intentionally deferred to migration follow-up.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentId =
  | "Assistant"
  | "PipelineManager"
  | "DataArchitect"
  | "DataAnalyst";

export interface TaskStackEntry {
  /** PascalCase agent id of the paused specialist (matches AgentId). */
  extensionId: string;
  /** Short human-readable description of what they were working on. */
  reason: string;
}

export interface AgentLoopContext {
  /** Canvas state forwarded to factory tools that need to read it. */
  canvasState: unknown;
  /** End-user identity, used by the few tools that write to per-user state. */
  userId: string;
  /** Paused-task stack (depth-1 today). The Assistant's `handoff` tool
   *  inspects this to allow stack-pop resumes while blocking new
   *  handoffs above the depth limit. */
  taskStack: TaskStackEntry[];
}

export type LoopEvent =
  | {
      type: "text-delta";
      iteration: number;
      payload: { delta: string };
    }
  | {
      type: "model-finish";
      iteration: number;
      payload: { text: string; finishReason: string; toolCallCount: number };
    }
  | {
      type: "tool-call";
      iteration: number;
      payload: { toolCallId: string; toolName: string; input: unknown };
    }
  | {
      type: "tool-result";
      iteration: number;
      payload: { toolCallId: string; output: unknown };
    }
  | {
      type: "loop-finish";
      iteration: number;
      payload: {
        agentId: AgentId;
        finalText: string;
        modelStepInvocations: number;
        toolStepInvocations: number;
      };
    };

interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ModelStepResult {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
}

// ---------------------------------------------------------------------------
// Agent configs — per-agent system prompt + which tools are exposed.
//
// Real production cutover would render `AGENT.md` (frontmatter + body) here
// instead of inlining shortened test instructions. The intent of the spike
// is to prove agent dispatch + per-tool durability, not to faithfully
// reproduce every prompt seam.
// ---------------------------------------------------------------------------

const AGENT_CONFIGS: Record<AgentId, { system: string; toolNames: string[]; maxLoopSteps: number }> = {
  Assistant: {
    // The `{{taskStack}}` seam is substituted per-turn inside `runModelStep`
    // because the paused-task block depends on the workflow input, not the
    // static config. The specialists block is hardcoded here — it changes
    // only when a new specialist agent ships.
    system: `You are the Lattik Studio Assistant — the main AI assistant for Lattik Studio, an agentic analytics platform.

You help users with their analytics needs. When a user's request matches a specialized agent, hand off to that agent using the handoff tool.

Available agents:
- **Pipeline Manager** (id: "PipelineManager"): Monitor and operate Airflow DAGs — list runs, inspect task state, dig into failures.
- **Data Architect** (id: "DataArchitect"): Define data pipeline concepts (entities, dimensions, logger tables, lattik tables, metrics) and submit them as PRs.
- **Data Analyst** (id: "DataAnalyst"): Explore data with SQL — list tables, run queries, render charts.

## When to hand off
- If the user's request clearly matches an available agent's specialty → hand off
- For general questions, greetings, or tasks that don't match any agent → handle them yourself

## Routing rules (apply before asking the user)
- **Any delete / drop / remove request** targeting a table, definition, entity, dimension, logger table, lattik table, or metric → hand off to the **Data Architect** agent (id: "DataArchitect") without asking. The Data Architect owns all deletion flows; the Data Analyst is not allowed to delete.

## Guidelines
- Be friendly and concise.
- When handing off, briefly tell the user which agent you're routing them to and why.

{{taskStack}}`,
    toolNames: ["handoff"],
    maxLoopSteps: 5,
  },
  PipelineManager: {
    system: `You are the Pipeline Manager agent in Lattik Studio. You help users monitor and operate their data pipelines (Airflow DAGs).

## Canvas Rendering — STRICT
**ANY request that asks to see, list, show, view, or browse DAGs — including "list my DAGs", "what DAGs do I have", "show me the DAGs", or any phrasing that means the user wants to see the DAG inventory — MUST be answered by calling \`renderDagOverview\` FIRST.** This is non-negotiable. The canvas IS the answer for these requests. \`listDags\` is for follow-up questions about specific properties; never call it for the initial "show me / list / what DAGs" question.

When the user asks about a specific run, call \`renderDagRunDetail\` to show the task graph.

After calling a render tool, acknowledge briefly in prose (one sentence) and let the user interact with the canvas. NEVER emit a \`spec\` code fence or any JSONL patches — the render tools are the only canvas-rendering mechanism.

## Investigating a DAG
Use \`getDagDetail\` / \`listDagRuns\` / \`getTaskInstances\` / \`getTaskLogs\` to dig into specifics after the canvas is rendered. Use \`listDags\` only when the user asks about something the canvas doesn't already show (e.g. raw schedule strings, owners, etc.). Be concise.`,
    toolNames: [
      "renderDagOverview",
      "renderDagRunDetail",
      "listDags",
      "getDagDetail",
      "listDagRuns",
      "getTaskInstances",
      "getTaskLogs",
    ],
    maxLoopSteps: 6,
  },
  DataArchitect: {
    system: `You are the Data Architect agent in Lattik Studio. You help users define data pipeline concepts: Entities, Dimensions, Logger Tables, Lattik Tables, and Metrics.

## Canvas Rendering — STRICT
**ANY define-X request — "define an entity called orders", "create a dimension", "add a logger table", etc. — MUST be answered by calling the matching renderXForm tool FIRST.** Pick:
- \`renderEntityForm\` for entities
- \`renderDimensionForm\` for dimensions
- \`renderLoggerTableForm\` for logger tables
- \`renderLattikTableForm\` for lattik tables
- \`renderMetricForm\` for metrics

Pre-fill every field you can reasonably infer from the user's message — name, description, columns, retention, grain, etc. The form fields ARE the questions; never ask in chat first. The user fills in the rest on the canvas.

## PR Submission Flow
After the user is happy with the form, the fixed sequence is:
1. \`staticCheck\` — fix any errors before continuing.
2. \`updateDefinition\` — save the draft.
3. \`generateYaml\` — renders the editable YAML on the canvas. STOP and ask if they want to create the PR. The user may edit the YAML before answering.
4. \`submitPR\` — only after explicit confirmation. Share the returned \`prUrl\` as a clickable markdown link.

## Browse / Delete
- \`listDefinitions\` and \`getDefinition\` for "show me my definitions" / "what's in X".
- \`deleteDefinition\` for "delete the X definition" — note the YAML deletion is separate from dropping the warehouse table.

Be concise.`,
    toolNames: [
      "renderEntityForm",
      "renderDimensionForm",
      "renderLoggerTableForm",
      "renderLattikTableForm",
      "renderMetricForm",
      "staticCheck",
      "updateDefinition",
      "generateYaml",
      "submitPR",
      "deleteDefinition",
      "listDefinitions",
      "getDefinition",
    ],
    maxLoopSteps: 10,
  },
  DataAnalyst: {
    system:
      "You are the Data Analyst spike agent. You explore data using SQL. Use listTables to see what's available, describeTable to understand schemas, runQuery to execute SQL, and renderSqlEditor when the user wants to compose a query interactively. Be concise.",
    toolNames: ["listTables", "describeTable", "runQuery", "renderSqlEditor"],
    maxLoopSteps: 6,
  },
};

// ---------------------------------------------------------------------------
// Tool definitions surfaced to the model. Keyed by tool name; built lazily
// inside the model step because zodSchema's wrapper has a Symbol-keyed
// property that fails to cross the workflow→step serialization boundary.
// ---------------------------------------------------------------------------

const definitionKindEnum = z.enum([
  "entity",
  "dimension",
  "logger_table",
  "lattik_table",
  "metric",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DEFINITIONS: Record<string, () => any> = {
  // PipelineManager
  listDags: () =>
    tool({
      description:
        "Fetch raw DAG metadata as JSON (DAG ID, description, schedule cron, paused status, tags) for follow-up questions about specific properties. Do NOT call this for the user's initial 'list / show / what DAGs do I have' question — that question is answered by `renderDagOverview` rendering the canvas. Use this only when the user asks for something the canvas doesn't show (raw schedule strings, owners, etc.).",
      inputSchema: zodSchema(
        z.object({
          limit: z.number().optional().describe("Max number of DAGs (default 50)"),
        }),
      ),
    }),
  getDagDetail: () =>
    tool({
      description:
        "Get full detail for a specific DAG: schedule, paused status, tags, owners, and a structured task list.",
      inputSchema: zodSchema(
        z.object({ dagId: z.string().describe("The DAG ID to fetch detail for") }),
      ),
    }),
  listDagRuns: () =>
    tool({
      description:
        "List recent runs for a DAG. Each entry includes run id, start/end times, state, and external trigger flag.",
      inputSchema: zodSchema(
        z.object({
          dagId: z.string(),
          limit: z.number().optional(),
        }),
      ),
    }),
  getTaskInstances: () =>
    tool({
      description:
        "List task instances for a specific DAG run, with state, start/end, duration, and try number.",
      inputSchema: zodSchema(
        z.object({ dagId: z.string(), dagRunId: z.string() }),
      ),
    }),
  getTaskLogs: () =>
    tool({
      description:
        "Fetch the log output for a specific task try (1-indexed), used to investigate failures.",
      inputSchema: zodSchema(
        z.object({
          dagId: z.string(),
          dagRunId: z.string(),
          taskId: z.string(),
          tryNumber: z.number(),
        }),
      ),
    }),
  renderDagOverview: () =>
    tool({
      description:
        "Render the DAG overview on the canvas. Shows all Lattik-managed DAGs as cards with status badges, schedule, last run result, and visual run history. This is the starting point for any monitoring workflow. Call this BEFORE writing prose.",
      inputSchema: zodSchema(z.object({})),
    }),
  renderDagRunDetail: () =>
    tool({
      description:
        "Render a specific DAG run's task graph on the canvas — task nodes, dependencies, per-task state. Use when the user wants to inspect a particular run.",
      inputSchema: zodSchema(
        z.object({ dagId: z.string(), dagRunId: z.string() }),
      ),
    }),
  // DataArchitect — render-form tools (one per definition kind).
  renderEntityForm: () =>
    tool({
      description:
        "Render an Entity definition form on the canvas. Pre-fill `initialState` with whatever the user said (name, description, attributes). The form is editable on the canvas afterwards.",
      inputSchema: zodSchema(
        z.object({
          initialState: z
            .object({
              name: z.string().optional(),
              description: z.string().optional(),
            })
            .optional(),
        }),
      ),
    }),
  renderDimensionForm: () =>
    tool({
      description:
        "Render a Dimension definition form on the canvas. Pre-fill `initialState` with anything you can infer (name, description, entity it belongs to, value column).",
      inputSchema: zodSchema(
        z.object({ initialState: z.record(z.string(), z.unknown()).optional() }),
      ),
    }),
  renderLoggerTableForm: () =>
    tool({
      description:
        "Render a Logger Table definition form on the canvas. Pre-fill `initialState` with anything you can infer (name, description, columns with types, retention, dedup).",
      inputSchema: zodSchema(
        z.object({ initialState: z.record(z.string(), z.unknown()).optional() }),
      ),
    }),
  renderLattikTableForm: () =>
    tool({
      description:
        "Render a Lattik Table (materialized view) form on the canvas. Pre-fill `initialState` with anything you can infer (name, description, source tables, grain, schedule).",
      inputSchema: zodSchema(
        z.object({ initialState: z.record(z.string(), z.unknown()).optional() }),
      ),
    }),
  renderMetricForm: () =>
    tool({
      description:
        "Render a Metric definition form on the canvas. Pre-fill `initialState` with anything you can infer (name, description, source table, expression, aggregation).",
      inputSchema: zodSchema(
        z.object({ initialState: z.record(z.string(), z.unknown()).optional() }),
      ),
    }),
  // DataArchitect — PR-flow factory tools (need canvasState; updateDefinition
  // additionally needs the verified userId).
  staticCheck: () =>
    tool({
      description:
        "Run static validation against the current canvas form state for the given definition kind. Returns errors keyed by field path. Always call this before `updateDefinition`.",
      inputSchema: zodSchema(z.object({ kind: definitionKindEnum })),
    }),
  updateDefinition: () =>
    tool({
      description:
        "Save the current canvas draft as a definition the user owns. Use after `staticCheck` passes.",
      inputSchema: zodSchema(
        z.object({
          kind: definitionKindEnum,
          name: z.string().describe("The canonical name (snake_case)"),
        }),
      ),
    }),
  generateYaml: () =>
    tool({
      description:
        "Render the YAML preview for the current canvas draft on the canvas. STOP after calling and ask whether to create the PR — the user may edit the YAML before answering.",
      inputSchema: zodSchema(z.object({ kind: definitionKindEnum })),
    }),
  submitPR: () =>
    tool({
      description:
        "Open a Gitea PR for the YAML currently shown on the canvas. Returns `{ status: 'submitted', prUrl }` on success — share the prUrl as a clickable markdown link in your reply.",
      inputSchema: zodSchema(
        z.object({
          kind: definitionKindEnum,
          name: z.string(),
        }),
      ),
    }),
  // DataArchitect — browse + delete (pure).
  listDefinitions: () =>
    tool({
      description:
        "List the user's saved definitions, optionally filtered by kind.",
      inputSchema: zodSchema(
        z.object({ kind: definitionKindEnum.optional() }),
      ),
    }),
  getDefinition: () =>
    tool({
      description:
        "Fetch a previously-saved definition by name (any kind), returning the YAML spec body.",
      inputSchema: zodSchema(
        z.object({ name: z.string().describe("Definition name") }),
      ),
    }),
  deleteDefinition: () =>
    tool({
      description:
        "Open a Gitea PR that deletes a definition's YAML file. NOTE: this only stops the pipeline going forward; it does not drop the warehouse table. Tell the user that part is manual.",
      inputSchema: zodSchema(
        z.object({
          name: z.string(),
          kind: definitionKindEnum.optional(),
        }),
      ),
    }),
  // DataAnalyst
  listTables: () =>
    tool({
      description:
        "List queryable tables in the data lake, optionally filtered by catalog or schema.",
      inputSchema: zodSchema(
        z.object({
          catalog: z.string().optional(),
          schema: z.string().optional(),
        }),
      ),
    }),
  describeTable: () =>
    tool({
      description: "Describe a table's columns and types.",
      inputSchema: zodSchema(
        z.object({
          catalog: z.string(),
          schema: z.string(),
          table: z.string(),
        }),
      ),
    }),
  runQuery: () =>
    tool({
      description:
        "Execute a SQL query against the data lake (read-only — SELECT/SHOW/DESCRIBE only). Returns column metadata + row data.",
      inputSchema: zodSchema(
        z.object({
          sql: z.string().describe("The SQL to execute"),
          limit: z.number().optional(),
        }),
      ),
    }),
  renderSqlEditor: () =>
    tool({
      description:
        "Render a SQL editor on the canvas, optionally pre-filled with starter SQL.",
      inputSchema: zodSchema(
        z.object({ initialSql: z.string().optional() }),
      ),
    }),
  // Assistant — concierge handoff. The actual stack-depth check lives in
  // the `createHandoffTool` factory at dispatch time (it needs the live
  // taskStack from per-request context).
  handoff: () =>
    tool({
      description:
        "Hand off the conversation to a specialized agent. Use this when the user's request matches an available agent.",
      inputSchema: zodSchema(
        z.object({
          agentId: z.string().describe("The id of the agent to hand off to"),
          reason: z.string().describe("Brief reason for the handoff"),
        }),
      ),
    }),
};

// ---------------------------------------------------------------------------
// Tool dispatchers — map a tool name + per-request context to its actual
// `execute`. Pure tools ignore the context; factory tools call their
// constructor with the context so they get the per-run canvasState / userId
// they expect via closure.
// ---------------------------------------------------------------------------

// Tool execute return types are wider than Promise<unknown> (the AI SDK
// allows AsyncIterable for streamed outputs). The dispatcher just hands
// it back; the awaiter inside the step handles whatever surface comes out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dispatcher = (input: unknown, ctx: AgentLoopContext) => any;

const TOOL_DISPATCHERS: Record<string, Dispatcher> = {
  // PipelineManager
  listDags: (input) => listDagsTool.execute!(input as never, {} as never),
  getDagDetail: (input) => getDagDetailTool.execute!(input as never, {} as never),
  listDagRuns: (input) => listDagRunsTool.execute!(input as never, {} as never),
  getTaskInstances: (input) =>
    getTaskInstancesTool.execute!(input as never, {} as never),
  getTaskLogs: (input) => getTaskLogsTool.execute!(input as never, {} as never),
  renderDagOverview: (input) =>
    renderDagOverviewTool.execute!(input as never, {} as never),
  renderDagRunDetail: (input) =>
    renderDagRunDetailTool.execute!(input as never, {} as never),
  // DataArchitect — render-form tools (pure).
  renderEntityForm: (input) => renderEntityFormTool.execute!(input as never, {} as never),
  renderDimensionForm: (input) =>
    renderDimensionFormTool.execute!(input as never, {} as never),
  renderLoggerTableForm: (input) =>
    renderLoggerTableFormTool.execute!(input as never, {} as never),
  renderLattikTableForm: (input) =>
    renderLattikTableFormTool.execute!(input as never, {} as never),
  renderMetricForm: (input) =>
    renderMetricFormTool.execute!(input as never, {} as never),
  // DataArchitect — PR-flow factory tools.
  staticCheck: (input, ctx) =>
    createStaticCheckTool({ getCanvasState: () => ctx.canvasState }).execute!(
      input as never,
      {} as never,
    ),
  updateDefinition: (input, ctx) =>
    createUpdateDefinitionTool({
      getCanvasState: () => ctx.canvasState,
      userId: ctx.userId,
    }).execute!(input as never, {} as never),
  generateYaml: (input, ctx) =>
    createGenerateYamlTool({ getCanvasState: () => ctx.canvasState }).execute!(
      input as never,
      {} as never,
    ),
  submitPR: (input, ctx) =>
    createSubmitPRTool({ getCanvasState: () => ctx.canvasState }).execute!(
      input as never,
      {} as never,
    ),
  // DataArchitect — pure browse + delete.
  listDefinitions: (input) =>
    listDefinitionsTool.execute!(input as never, {} as never),
  getDefinition: (input) => getDefinitionTool.execute!(input as never, {} as never),
  deleteDefinition: (input) =>
    deleteDefinitionTool.execute!(input as never, {} as never),
  // DataAnalyst — all pure
  listTables: (input) => listTablesTool.execute!(input as never, {} as never),
  describeTable: (input) => describeTableTool.execute!(input as never, {} as never),
  runQuery: (input) => runQueryTool.execute!(input as never, {} as never),
  renderSqlEditor: (input) => renderSqlEditorTool.execute!(input as never, {} as never),
  // Assistant — handoff factory captures the live taskStack so it can
  // enforce the depth-1 stack limit and detect resume-of-paused.
  handoff: (input, ctx) =>
    createHandoffTool({ taskStack: ctx.taskStack }).execute!(
      input as never,
      {} as never,
    ),
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth sanitizer for paused-task `reason` strings, which
 * arrive in user-controlled request payloads and land in the Assistant's
 * system prompt. Strip control chars and the triple-backtick fence
 * delimiter that could be used to break out of the system block.
 */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/```/g, "''")
    .slice(0, 500);
}

/**
 * Render the per-turn `{{taskStack}}` block for the Assistant's system
 * prompt. Returns "" when nothing is paused — the prompt has the seam
 * always, but the Assistant only needs the special instructions when a
 * task is on the stack.
 */
function renderTaskStackBlock(taskStack: TaskStackEntry[]): string {
  const top = taskStack.length > 0 ? taskStack[taskStack.length - 1] : null;
  if (!top) return "";
  return `\n## Paused Task\nThere is a paused task on the stack: the "${top.extensionId}" agent was working on "${sanitizeForPrompt(top.reason)}" and is waiting to resume.\n- Do NOT hand off to a different specialist — handle the user's new request yourself.\n- When the user indicates they are done with their current request ("that's all", "nothing else", "I'm done", etc.), use the handoff tool to resume the paused agent (agentId: "${top.extensionId}") so it can continue where it left off.\n- Briefly tell the user you're handing them back to the paused agent.`;
}

async function runModelStep(input: {
  iteration: number;
  agentId: AgentId;
  messages: ModelMessage[];
  /** Forwarded so the Assistant's system prompt can render its
   *  `{{taskStack}}` seam per-turn. Other agents ignore it. */
  taskStack: TaskStackEntry[];
}): Promise<ModelStepResult> {
  "use step";
  const config = AGENT_CONFIGS[input.agentId];
  if (!config) {
    throw new Error(`Unknown agentId: ${input.agentId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const name of config.toolNames) {
    const builder = TOOL_DEFINITIONS[name];
    if (!builder) {
      throw new Error(
        `Tool "${name}" listed in ${input.agentId} config has no TOOL_DEFINITIONS entry`,
      );
    }
    tools[name] = builder();
  }

  // Substitute the `{{taskStack}}` seam if present (only the Assistant
  // template has it today). Cheap noop for the other agents.
  const systemPrompt = config.system.includes("{{taskStack}}")
    ? config.system.replace("{{taskStack}}", renderTaskStackBlock(input.taskStack))
    : config.system;

  const result = streamText({
    model: gateway("anthropic/claude-haiku-4.5"),
    system: systemPrompt,
    messages: input.messages,
    tools,
  });

  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  try {
    for await (const delta of result.textStream) {
      if (delta) {
        await writer.write({
          type: "text-delta",
          iteration: input.iteration,
          payload: { delta },
        });
      }
    }
    const [text, toolCalls, finishReason] = await Promise.all([
      result.text,
      result.toolCalls,
      result.finishReason,
    ]);
    await writer.write({
      type: "model-finish",
      iteration: input.iteration,
      payload: { text, finishReason, toolCallCount: toolCalls.length },
    });
    return {
      text,
      toolCalls: toolCalls.map((c) => ({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
      })),
      finishReason,
    };
  } finally {
    writer.releaseLock();
  }
}

async function runToolStep(input: {
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
  context: AgentLoopContext;
}): Promise<unknown> {
  "use step";
  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  await writer.write({
    type: "tool-call",
    iteration: input.iteration,
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
    },
  });

  const dispatcher = TOOL_DISPATCHERS[input.toolName];
  let output: unknown;
  if (!dispatcher) {
    output = { error: `Unknown tool: ${input.toolName}` };
  } else {
    try {
      output = await dispatcher(input.input, input.context);
    } catch (err) {
      output = {
        error: `Tool ${input.toolName} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  try {
    await writer.write({
      type: "tool-result",
      iteration: input.iteration,
      payload: { toolCallId: input.toolCallId, output },
    });
  } finally {
    writer.releaseLock();
  }

  return output;
}

// ---------------------------------------------------------------------------
// Conversation persistence steps. Reads/writes the same `conversation` row
// that apps/web's `saveConversation` server action manages, so the workflow
// can pick up where prior turns left off and replay them on reattach. The
// row stores `messages: UIMessage[]` (not ModelMessage[]) — that's the
// shape `useChat` consumes — so the workflow body keeps both views in
// parallel: the prior UI history is what gets persisted, and a freshly
// converted ModelMessage[] is what gets fed to the model.
//
// Both steps are owner-guarded by `userId`. The load step returns `null`
// when no conversation exists yet (first turn). The commit step does an
// idempotent UPSERT scoped by (id, userId), so replays don't double-write.
// ---------------------------------------------------------------------------

async function loadConversationStep(input: {
  conversationId: string;
  userId: string;
}): Promise<{ messages: UIMessage[]; title: string } | null> {
  "use step";
  const db = getDb();
  const rows = await db
    .select({
      messages: conversations.messages,
      title: conversations.title,
      userId: conversations.userId,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  // Owner check — silently treat a foreign-owned conversation the same as
  // a missing one rather than leaking its existence.
  if (row.userId !== input.userId) return null;
  return {
    messages: (row.messages ?? []) as UIMessage[],
    title: row.title,
  };
}

async function commitConversationStep(input: {
  conversationId: string;
  userId: string;
  title: string;
  messages: UIMessage[];
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .insert(conversations)
    .values({
      id: input.conversationId,
      userId: input.userId,
      title: input.title,
      messages: input.messages,
    })
    .onConflictDoUpdate({
      target: conversations.id,
      set: {
        title: input.title,
        messages: input.messages,
        updatedAt: new Date(),
      },
      // Owner guard — a conflict where the existing row belongs to a
      // different user resolves to no-op rather than reassigning.
      setWhere: eq(conversations.userId, input.userId),
    });
}

async function runLoopFinishStep(input: {
  iteration: number;
  agentId: AgentId;
  finalText: string;
  modelStepInvocations: number;
  toolStepInvocations: number;
}): Promise<void> {
  "use step";
  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write({
      type: "loop-finish",
      iteration: input.iteration,
      payload: input,
    });
  } finally {
    await writer.close();
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

export interface AgentLoopInput {
  agentId: AgentId;
  /** Stable conversation id; the workflow loads prior history from the DB
   *  and persists the new turn back at the end. */
  conversationId: string;
  /** New user-side messages this turn — typically a single UIMessage with
   *  one text part. Concatenated to the prior history before running.
   *  Empty for `regenerate-message` turns: the prior user message that
   *  drives regeneration is already in the (truncated) DB history. */
  newUserMessages: UIMessage[];
  canvasState: unknown;
  userId: string;
  /** Paused-task stack; only meaningful for the Assistant agent. Empty
   *  array for the rest. */
  taskStack: TaskStackEntry[];
  /** Regenerate-message hint. If set, the workflow truncates its
   *  DB-loaded prior history at this message id (exclusive — drops the
   *  matching message and everything after) before running. The web
   *  client passes the assistant message id that `useChat`'s regenerate
   *  flow targets; the workflow re-runs the model on the resulting
   *  shorter history and the new assistant turn replaces the old one
   *  in the persisted conversation. Unknown ids no-op (treated as
   *  "history matches what the client sees, nothing to truncate"),
   *  which is safer than 400-erroring on stale state. */
  regenerateFromMessageId?: string;
}

export async function agentLoopWorkflow(input: AgentLoopInput) {
  "use workflow";

  const config = AGENT_CONFIGS[input.agentId];
  if (!config) {
    throw new Error(`Unknown agentId: ${input.agentId}`);
  }

  // Load prior conversation state (or start fresh). The owner guard lives
  // in `loadConversationStep` — a foreign-owned id reads as null.
  const prior = await loadConversationStep({
    conversationId: input.conversationId,
    userId: input.userId,
  });
  let priorMessages: UIMessage[] = prior?.messages ?? [];

  // Regenerate-message: truncate the DB history at the targeted message
  // (exclusive) before running. The new assistant response replaces the
  // old one. Unknown id → no-op truncation.
  if (input.regenerateFromMessageId) {
    const idx = priorMessages.findIndex(
      (m) => m.id === input.regenerateFromMessageId,
    );
    if (idx >= 0) {
      priorMessages = priorMessages.slice(0, idx);
    }
  }

  const fullUiHistory: UIMessage[] = [...priorMessages, ...input.newUserMessages];

  const messages: ModelMessage[] = await convertToModelMessages(fullUiHistory);
  const context: AgentLoopContext = {
    canvasState: input.canvasState,
    userId: input.userId,
    taskStack: input.taskStack,
  };

  let iterations = 0;
  let modelStepInvocations = 0;
  let toolStepInvocations = 0;
  let finalText = "";

  while (iterations < config.maxLoopSteps) {
    const modelResult = await runModelStep({
      iteration: iterations,
      agentId: input.agentId,
      messages,
      taskStack: input.taskStack,
    });
    modelStepInvocations++;

    const assistantContent: NonNullable<
      Extract<ModelMessage, { role: "assistant" }>["content"]
    > = [];
    if (modelResult.text) {
      assistantContent.push({ type: "text", text: modelResult.text });
    }
    for (const tc of modelResult.toolCalls) {
      assistantContent.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input as never,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    if (modelResult.toolCalls.length === 0) {
      finalText = modelResult.text;
      break;
    }

    for (const tc of modelResult.toolCalls) {
      const output = await runToolStep({
        iteration: iterations,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
        context,
      });
      toolStepInvocations++;
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "json", value: output as never },
          },
        ],
      });
    }

    iterations++;
  }

  // Build a single assistant UIMessage from finalText. Tool-call detail
  // lives in the workflow run's persisted events under runId — recoverable
  // via reattach if a richer view is ever needed. The id is generated
  // deterministically from runId so replay produces the same message
  // identity (the workflow runtime injects `runId` via `WORKFLOW_RUN_ID`
  // env at step start, but for the workflow-body-side id we just use a
  // stable per-conversation suffix).
  const assistantUiMessage: UIMessage = {
    id: `wfm_${input.conversationId}_${Date.now()}`,
    role: "assistant",
    parts: finalText ? [{ type: "text", text: finalText }] : [],
  };

  // Title heuristic: first 80 chars of the first user message text, or
  // keep the existing one if this isn't the first turn.
  const firstUserText = (() => {
    const firstUser = [...priorMessages, ...input.newUserMessages].find(
      (m) => m.role === "user",
    );
    if (!firstUser) return "New conversation";
    const textPart = firstUser.parts.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    );
    return textPart?.text.slice(0, 80) ?? "New conversation";
  })();
  const title = prior?.title ?? firstUserText;

  await commitConversationStep({
    conversationId: input.conversationId,
    userId: input.userId,
    title,
    messages: [...priorMessages, ...input.newUserMessages, assistantUiMessage],
  });

  await runLoopFinishStep({
    iteration: iterations,
    agentId: input.agentId,
    finalText,
    modelStepInvocations,
    toolStepInvocations,
  });

  return {
    finalText,
    iterations,
    modelStepInvocations,
    toolStepInvocations,
    persistedTurns: priorMessages.length / 2 + 1,
  };
}
