import {
  defineEventHandler,
  setResponseHeader,
  readValidatedBody,
  createError,
} from "h3";
import { z } from "zod";
import type { UIMessage } from "ai";
import { start } from "workflow/api";
import {
  agentLoopWorkflow,
  type AgentId,
} from "../workflows/agent-loop.js";
import { recordRunOwner } from "../lib/workflow-runs.js";

// Spike: kicks off the generalized per-tool-durable agent loop. Pick the
// agent via `agentId` (PipelineManager / DataArchitect / DataAnalyst).
// `userId` comes from the verified auth context, NOT the request body —
// the trusted client (web / slack-bot / discord-bot) authenticates its
// own user and asserts identity via `X-User-Id`. Stream is NDJSON-encoded
// for easy curl inspection.

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
  /** New user-side messages this turn — typically just one with a text
   *  part. The workflow loads prior history from the DB and appends. */
  newUserMessages: z.array(z.unknown()).default([]),
  canvasState: z.unknown().optional(),
  taskStack: z.array(taskStackEntrySchema).default([]),
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
  setResponseHeader(event, "content-type", "application/x-ndjson");
  setResponseHeader(event, "cache-control", "no-cache");

  const encoder = new TextEncoder();
  return run.readable.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
      },
    }),
  );
});
