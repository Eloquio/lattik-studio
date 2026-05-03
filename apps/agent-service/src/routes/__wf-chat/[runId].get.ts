import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { JsonToSseTransformStream, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import type { LoopEvent } from "../../workflows/agent-loop.js";
import { loopEventToUIMessageChunk } from "../../lib/loop-event-to-ui-chunk.js";
import { assertRunOwner } from "../../lib/workflow-runs.js";

// SSE-encoded reattach for `__wf-chat.post.ts`. Reads from
// `?startIndex=N` (negative-from-tail supported) and pipes through the
// same translator the POST route uses, so a reconnecting `useChat`
// client picks up the tail in the wire format it expects.
//
// Caveat: text-part lifecycle is ID'd by iteration (`t<N>`). Mid-step
// reattach may emit only `text-delta` chunks for an iteration whose
// `text-start` was already in the prior chunks the client missed. The
// AI SDK's reducer handles this gracefully (text just appears) but the
// shape is technically out of spec. A more rigorous reattach would
// reconstruct the prefix events from the loop's prior persisted state;
// deferred.
//
// Auth via `attachAuth` middleware + per-run ownership check against
// the `workflow_run` table written when the run was started.
// Foreign-owned runIds 404 to avoid leaking existence.

export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  if (!auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: "Missing runId" });
  }
  await assertRunOwner({ runId, userId: auth.userId });
  const startIndexRaw = getQuery(event).startIndex;
  const startIndex =
    typeof startIndexRaw === "string" ? Number.parseInt(startIndexRaw, 10) : undefined;

  const run = getRun<unknown>(runId);
  const readable = run.getReadable<LoopEvent>(
    startIndex !== undefined && Number.isFinite(startIndex) ? { startIndex } : {},
  );

  setResponseHeader(event, "x-run-id", runId);
  setResponseHeader(event, "x-tail-index", String(await readable.getTailIndex()));
  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "x-vercel-ai-ui-message-stream", "v1");

  return readable
    .pipeThrough(loopEventToUIMessageChunk())
    .pipeThrough(new JsonToSseTransformStream() as unknown as TransformStream<
      UIMessageChunk,
      string
    >)
    .pipeThrough(new TextEncoderStream());
});
