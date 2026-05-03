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

// DataArchitect tools — only `renderEntityForm` for now. The richer factory
// tools (`staticCheck`, `updateDefinition`, `getDefinition`, etc.) live in
// `definition-flow.ts`, which transitively imports `lib/validation/index.ts`
// + `lib/validation/referential.ts`. Those use TypeScript's `moduleResolution:
// "Bundler"` `.js`-pointing-at-`.ts`-source idiom; nitropack's rollup
// resolves it, but `@workflow/builders`'s esbuild step-bundle pass marks
// any non-step / non-serde file as external and emits literal `.ts`
// imports that Node ESM rejects at runtime. Dynamic `import()` doesn't
// dodge this — esbuild static-resolves string-literal paths. Wiring the
// factory tools cleanly needs either: (a) editing the source to use
// extensionless imports throughout the DA validation chain, or (b)
// configuring the workflow build to inline them. Both deferred to a
// separate slice.
import { renderEntityFormTool } from "../agents/DataArchitect/tools/render-forms.js";

// DataAnalyst tools (all pure)
import {
  listTablesTool,
  describeTableTool,
  runQueryTool,
} from "../agents/DataAnalyst/tools/data-tools.js";
import { renderSqlEditorTool } from "../agents/DataAnalyst/tools/render-tools.js";

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

export type AgentId = "PipelineManager" | "DataArchitect" | "DataAnalyst";

export interface AgentLoopContext {
  /** Canvas state forwarded to factory tools that need to read it. */
  canvasState: unknown;
  /** End-user identity, used by the few tools that write to per-user state. */
  userId: string;
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
      payload: { toolCallId: string; toolName: string };
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
  PipelineManager: {
    system:
      "You are the Pipeline Manager spike agent. Use the available tools to investigate the user's request, then answer concisely. Stop calling tools as soon as you have enough information to respond.",
    toolNames: ["listDags", "getDagDetail"],
    maxLoopSteps: 6,
  },
  DataArchitect: {
    system:
      "You are the Data Architect spike agent. You help users define data pipeline concepts. For define-entity requests, FIRST call `renderEntityForm` to put a form on the canvas with whatever fields you can infer from the user's message (name, description). Never ask clarifying questions in chat first — the form fields ARE the questions. Be concise.",
    // Spike scope: only `renderEntityForm` until the validation-chain bundle
    // issue (see import comment above) is resolved.
    toolNames: ["renderEntityForm"],
    maxLoopSteps: 6,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DEFINITIONS: Record<string, () => any> = {
  // PipelineManager
  listDags: () =>
    tool({
      description:
        "List all Lattik-managed Airflow DAGs. Returns DAG ID, description, schedule, paused status, and tags.",
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
  // DataArchitect (spike scope — see import comment for what's deferred)
  renderEntityForm: () =>
    tool({
      description:
        "Render an Entity definition form on the canvas. Pre-fill `initialState` with whatever the user said (name, description). The form is editable on the canvas afterwards.",
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
  // DataArchitect (spike scope)
  renderEntityForm: (input) => renderEntityFormTool.execute!(input as never, {} as never),
  // DataAnalyst — all pure
  listTables: (input) => listTablesTool.execute!(input as never, {} as never),
  describeTable: (input) => describeTableTool.execute!(input as never, {} as never),
  runQuery: (input) => runQueryTool.execute!(input as never, {} as never),
  renderSqlEditor: (input) => renderSqlEditorTool.execute!(input as never, {} as never),
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runModelStep(input: {
  iteration: number;
  agentId: AgentId;
  messages: ModelMessage[];
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

  const result = streamText({
    model: gateway("anthropic/claude-haiku-4.5"),
    system: config.system,
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
    payload: { toolCallId: input.toolCallId, toolName: input.toolName },
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
  uiMessages: UIMessage[];
  canvasState: unknown;
  userId: string;
}

export async function agentLoopWorkflow(input: AgentLoopInput) {
  "use workflow";

  const config = AGENT_CONFIGS[input.agentId];
  if (!config) {
    throw new Error(`Unknown agentId: ${input.agentId}`);
  }

  const messages: ModelMessage[] = await convertToModelMessages(input.uiMessages);
  const context: AgentLoopContext = {
    canvasState: input.canvasState,
    userId: input.userId,
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
  };
}
