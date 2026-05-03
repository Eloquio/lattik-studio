import {
  defineEventHandler,
  setResponseHeader,
  readValidatedBody,
  createError,
} from "h3";
import { z } from "zod";
import {
  JsonToSseTransformStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { start } from "workflow/api";
import {
  agentLoopWorkflow,
  type AgentId,
  type LoopEvent,
} from "../workflows/agent-loop.js";
import { loopEventToUIMessageChunk } from "../lib/loop-event-to-ui-chunk.js";
import { recordRunOwner } from "../lib/workflow-runs.js";

// Cutover-friendly chat endpoint: same workflow underneath as
// `__wf-agent.post.ts`, but emits SSE-encoded `UIMessageChunk`s — the
// wire format `useChat` consumes — instead of NDJSON `LoopEvent`s. This
// is the route the web client should point at to replace the existing
// `/chat` ToolLoopAgent route once the per-tool-durable shape is the
// production default.
//
// `userId` comes from the verified auth context. The body shape matches
// `__wf-agent.post.ts` for symmetry.

const agentIdSchema = z.enum([
  "Assistant",
  "PipelineManager",
  "DataArchitect",
  "DataAnalyst",
]);

const taskStackEntrySchema = z.object({
  extensionId: z.string(),
  reason: z.string(),
});

const bodySchema = z.object({
  agentId: agentIdSchema,
  conversationId: z.string().min(1),
  newUserMessages: z.array(z.unknown()).default([]),
  canvasState: z.unknown().optional(),
  /** Paused-task stack; only consumed by the Assistant. Other agents
   *  receive the array but ignore it. */
  taskStack: z.array(taskStackEntrySchema).default([]),
  /** Regenerate-message hint — assistant message id the workflow
   *  should truncate the DB history at (exclusive) before running. */
  regenerateFromMessageId: z.string().optional(),
});

export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  if (!auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }

  const body = await readValidatedBody(event, (raw) => bodySchema.safeParse(raw));
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${body.error.message}`,
    });
  }

  const run = await start(agentLoopWorkflow, [
    {
      agentId: body.data.agentId as AgentId,
      conversationId: body.data.conversationId,
      newUserMessages: body.data.newUserMessages as UIMessage[],
      canvasState: body.data.canvasState ?? null,
      userId: auth.userId,
      taskStack: body.data.taskStack,
      regenerateFromMessageId: body.data.regenerateFromMessageId,
    },
  ]);
  await recordRunOwner({
    runId: run.runId,
    userId: auth.userId,
    conversationId: body.data.conversationId,
  });

  setResponseHeader(event, "x-run-id", run.runId);
  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "x-vercel-ai-ui-message-stream", "v1");

  return run.readable
    .pipeThrough(loopEventToUIMessageChunk())
    .pipeThrough(new JsonToSseTransformStream() as unknown as TransformStream<
      UIMessageChunk,
      string
    >)
    .pipeThrough(new TextEncoderStream());
});

// Re-export so `__wf-chat/[runId].get.ts` doesn't have to import twice.
export type { LoopEvent };
