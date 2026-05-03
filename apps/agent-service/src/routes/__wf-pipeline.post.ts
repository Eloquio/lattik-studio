import {
  defineEventHandler,
  setResponseHeader,
  readValidatedBody,
  createError,
} from "h3";
import { z } from "zod";
import { JsonToSseTransformStream, type UIMessage, type UIMessageChunk } from "ai";
import { start } from "workflow/api";
import { pipelineManagerWorkflow } from "../workflows/pipeline-manager-run.js";
import { recordRunOwner } from "../lib/workflow-runs.js";

// Spike 4 (start side): chat-style POST that wraps a Pipeline Manager run in
// a workflow. Streams the run's UI message chunks back as SSE — the same
// wire format `createAgentUIStreamResponse` produces for /chat — so existing
// `useChat` callers can consume this endpoint with no client changes once
// they're pointed at it. The runId is surfaced via the `x-run-id` header
// for reattach via GET /__wf-stream/:runId.

const bodySchema = z.object({
  messages: z.array(z.unknown()),
  canvasState: z.unknown().optional(),
  resumeContext: z.string().optional(),
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

  const run = await start(pipelineManagerWorkflow, [
    {
      uiMessages: body.data.messages as UIMessage[],
      canvasState: body.data.canvasState,
      resumeContext: body.data.resumeContext,
    },
  ]);
  await recordRunOwner({ runId: run.runId, userId: auth.userId });

  setResponseHeader(event, "x-run-id", run.runId);
  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "x-vercel-ai-ui-message-stream", "v1");

  return run.readable
    .pipeThrough(new JsonToSseTransformStream() as unknown as TransformStream<
      UIMessageChunk,
      string
    >)
    .pipeThrough(new TextEncoderStream());
});
