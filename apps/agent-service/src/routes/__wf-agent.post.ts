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

// Spike: kicks off the generalized per-tool-durable agent loop. Pick the
// agent via `agentId` (PipelineManager / DataArchitect / DataAnalyst).
// Per-request state (canvasState, userId) flows through workflow input.
// Stream is NDJSON-encoded for easy curl inspection.

const agentIdSchema = z.enum(["PipelineManager", "DataArchitect", "DataAnalyst"]);

const bodySchema = z.object({
  agentId: agentIdSchema,
  conversationId: z.string().min(1),
  /** New user-side messages this turn — typically just one with a text
   *  part. The workflow loads prior history from the DB and appends. */
  newUserMessages: z.array(z.unknown()).default([]),
  canvasState: z.unknown().optional(),
  userId: z.string(),
});

export default defineEventHandler(async (event) => {
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
      userId: body.data.userId,
    },
  ]);

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
