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
// Strict-spec prefix reconstruction: the translator's state machine
// (whether it's emitted `start`, which iteration is open, whether
// there's an in-progress text-part) is sensitive to events that
// preceded the cursor. Without seeding from those events, the client
// would receive a fresh `start` + `start-step` + `text-start` even
// mid-stream — duplicates that AI SDK is tolerant of but that are
// technically out of spec. To avoid that, this route:
//   1. Reads the run's tail index up-front.
//   2. Resolves the (possibly negative) `?startIndex` to an absolute
//      position.
//   3. Opens the readable from index 0 and tells the translator to
//      `skipFirstN` events. The state machine consumes the prefix
//      silently and only starts emitting at the cursor — coherent
//      mid-stream prefix, no duplicates.
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
  const requestedStartIndex =
    typeof startIndexRaw === "string" ? Number.parseInt(startIndexRaw, 10) : undefined;

  const run = getRun<unknown>(runId);
  // First peek at the tail to resolve negative indices and clamp
  // positive ones. `getTailIndex` returns -1 for empty streams.
  const tailIndex = await run.getReadable<LoopEvent>({}).getTailIndex();
  const absoluteStartIndex =
    requestedStartIndex === undefined || !Number.isFinite(requestedStartIndex)
      ? 0
      : requestedStartIndex < 0
        ? Math.max(0, tailIndex + 1 + requestedStartIndex)
        : Math.min(requestedStartIndex, tailIndex + 1);

  // Open a fresh readable from index 0 — the translator's `skipFirstN`
  // is what gates output, not the workflow's own startIndex. This way
  // the state machine sees every prior event.
  const readable = run.getReadable<LoopEvent>({ startIndex: 0 });

  setResponseHeader(event, "x-run-id", runId);
  setResponseHeader(event, "x-tail-index", String(tailIndex));
  setResponseHeader(event, "x-resolved-start-index", String(absoluteStartIndex));
  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "x-vercel-ai-ui-message-stream", "v1");

  return readable
    .pipeThrough(loopEventToUIMessageChunk({ skipFirstN: absoluteStartIndex }))
    .pipeThrough(new JsonToSseTransformStream() as unknown as TransformStream<
      UIMessageChunk,
      string
    >)
    .pipeThrough(new TextEncoderStream());
});
