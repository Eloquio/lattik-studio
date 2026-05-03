import { getWritable } from "workflow";
import {
  generateText,
  gateway,
  tool,
  zodSchema,
  convertToModelMessages,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { listDagsTool } from "../agents/PipelineManager/tools/list-dags.js";
import { getDagDetailTool } from "../agents/PipelineManager/tools/get-dag-detail.js";

// Spike 5: per-tool durability via a hand-rolled tool-loop driven from the
// workflow body. Each model call AND each tool execution is its own step,
// so a worker crash mid-loop replays cached step results instead of
// re-incurring model + side-effect costs.
//
// Scope is deliberately narrow:
//   - Two tools only (listDags, getDagDetail) — extends trivially to all
//     Pipeline Manager tools by adding entries to TOOL_REGISTRY +
//     TOOL_DEFS_FOR_MODEL.
//   - Non-streaming (uses generateText, not streamText). Token-by-token
//     streaming layered on top of cached steps is a bigger piece — design
//     question is whether tokens come from `getWritable()` inside the model
//     step (lost on replay) or are reconstructed deterministically from the
//     cached final text (works with replay but loses live feel).
//
// Architectural notes that informed this shape:
//   - Nested step calls don't get cached. The `'use step'` directive only
//     creates a queued/durable boundary when called from `mode: 'workflow'`
//     code (workflow body); inside a step body it inlines. So the loop has
//     to live in the workflow body, and the model + tools have to be steps.
//   - Workflow body runs in a sandboxed VM with no fetch / no Node-only
//     APIs. Anything that touches the network (gateway, airflow API) must
//     be wrapped in a step.

const PIPELINE_MANAGER_INSTRUCTIONS = `You are the Pipeline Manager spike agent. Use the available tools to investigate the user's request, then answer concisely. Stop calling tools as soon as you have enough information to respond.`;

const MAX_LOOP_STEPS = 6;

// ---------------------------------------------------------------------------
// Stream events. Each step appends to the run's writable so external readers
// see structured progress (model-finish, tool-call, tool-result, loop-finish).
// `getWritable()` is only callable from within steps; the workflow body
// drives the loop but never writes directly.
// ---------------------------------------------------------------------------

export type LoopEvent =
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
        finalText: string;
        modelStepInvocations: number;
        toolStepInvocations: number;
      };
    };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

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

async function runModelStep(input: {
  iteration: number;
  messages: ModelMessage[];
  toolNames: string[];
}): Promise<ModelStepResult> {
  "use step";
  // Tool definitions live entirely inside the step. The workflow body only
  // tells us *which* tools to expose — schemas have a Symbol-keyed wrapper
  // (zodSchema) that can't cross the workflow→step serialization boundary,
  // so they have to be built here. No `execute` on any of them — AI SDK
  // will surface tool calls back to us instead of running them inline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const name of input.toolNames) {
    const builder = TOOL_DEFINITIONS[name];
    if (!builder) {
      throw new Error(`Unknown tool requested by workflow: ${name}`);
    }
    tools[name] = builder();
  }

  const result = await generateText({
    model: gateway("anthropic/claude-haiku-4.5"),
    system: PIPELINE_MANAGER_INSTRUCTIONS,
    messages: input.messages,
    tools,
  });

  // Emit a structured event into the run's stream so callers (and the
  // smoke test) can observe progress live. `getWritable()` is only
  // supported inside steps — workflow bodies have to delegate writes.
  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write({
      type: "model-finish",
      iteration: input.iteration,
      payload: {
        text: result.text,
        finishReason: result.finishReason,
        toolCallCount: result.toolCalls.length,
      },
    });
  } finally {
    writer.releaseLock();
  }

  return {
    text: result.text,
    toolCalls: result.toolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
    })),
    finishReason: result.finishReason,
  };
}

async function runToolStep(input: {
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
}): Promise<unknown> {
  "use step";
  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  await writer.write({
    type: "tool-call",
    iteration: input.iteration,
    payload: { toolCallId: input.toolCallId, toolName: input.toolName },
  });

  // Each tool's `execute` runs in this step's Node context — full access to
  // fetch / airflow client / etc. Errors are caught and returned as
  // `{ error }` payloads so the model can react in the next loop iteration
  // rather than the whole run failing.
  let output: unknown;
  try {
    switch (input.toolName) {
      case "listDags":
        output = await listDagsTool.execute!(input.input as never, {} as never);
        break;
      case "getDagDetail":
        output = await getDagDetailTool.execute!(input.input as never, {} as never);
        break;
      default:
        output = { error: `Unknown tool: ${input.toolName}` };
    }
  } catch (err) {
    output = {
      error: `Tool ${input.toolName} threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
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
  finalText: string;
  modelStepInvocations: number;
  toolStepInvocations: number;
}): Promise<void> {
  "use step";
  // Workflow bodies can't write to the run's stream directly, so the
  // terminal `loop-finish` marker rides on a tiny step whose only job is
  // to flush one event. Cheap (no I/O, no model) and keeps the wire
  // format consistent across producers.
  const writable = getWritable<LoopEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "loop-finish", iteration: input.iteration, payload: input });
  } finally {
    await writer.close();
  }
}

// ---------------------------------------------------------------------------
// Tool definitions surfaced to the model. Schemas are cloned from the real
// tools so the model sees the same contract; execute is intentionally
// stripped — the workflow body decides when to invoke each tool as a step.
// Built lazily inside `runModelStep` because zodSchema's wrapper has a
// Symbol-keyed property that fails to cross the workflow serialization
// boundary.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DEFINITIONS: Record<string, () => any> = {
  listDags: () =>
    tool({
      description:
        "List all Lattik-managed Airflow DAGs. Returns DAG ID, description, schedule, paused status, and tags. Only shows DAGs tagged 'lattik'.",
      inputSchema: zodSchema(
        z.object({
          limit: z
            .number()
            .optional()
            .describe("Max number of DAGs to return (default 50)"),
        }),
      ),
    }),
  getDagDetail: () =>
    tool({
      description:
        "Get full detail for a specific DAG: schedule, paused status, tags, owners, and a structured task list parsed from the latest serialized DAG.",
      inputSchema: zodSchema(
        z.object({
          dagId: z.string().describe("The DAG ID to fetch detail for"),
        }),
      ),
    }),
};

const ALL_TOOL_NAMES = Object.keys(TOOL_DEFINITIONS);

// ---------------------------------------------------------------------------
// Workflow body — drives the tool loop. Runs in the sandboxed VM, so every
// I/O bounce is a step call.
// ---------------------------------------------------------------------------

export interface PipelineManagerLoopInput {
  uiMessages: UIMessage[];
}

export async function pipelineManagerLoopWorkflow(input: PipelineManagerLoopInput) {
  "use workflow";

  const messages: ModelMessage[] = await convertToModelMessages(input.uiMessages);
  let iterations = 0;
  let modelStepInvocations = 0;
  let toolStepInvocations = 0;
  let finalText = "";

  while (iterations < MAX_LOOP_STEPS) {
    const modelResult = await runModelStep({
      iteration: iterations,
      messages,
      toolNames: ALL_TOOL_NAMES,
    });
    modelStepInvocations++;

    // Append the assistant turn to history. Mix text + tool-call parts in a
    // single content array — that's the v2 ModelMessage shape generateText
    // expects to see when continuing a conversation.
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

    // Run each tool call as its own step. Each step writes its own
    // tool-call / tool-result events into the run's stream, so we don't
    // need to from here.
    for (const tc of modelResult.toolCalls) {
      const output = await runToolStep({
        iteration: iterations,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
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
