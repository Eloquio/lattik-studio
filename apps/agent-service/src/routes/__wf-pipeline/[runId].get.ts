import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { JsonToSseTransformStream, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";

// Spike 4 (reattach side): SSE-encoded reconnection for an in-flight or
// completed Pipeline Manager run. Mirrors the spike-2 reattach contract
// (`?startIndex=N`, negative-from-tail), but JSON-encodes each chunk
// because the underlying readable carries `UIMessageChunk` objects rather
// than strings.

export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: "Missing runId" });
  }
  const startIndexRaw = getQuery(event).startIndex;
  const startIndex =
    typeof startIndexRaw === "string" ? Number.parseInt(startIndexRaw, 10) : undefined;

  const run = getRun<{ chunkCount: number }>(runId);
  const readable = run.getReadable<UIMessageChunk>(
    startIndex !== undefined && Number.isFinite(startIndex) ? { startIndex } : {},
  );

  setResponseHeader(event, "x-run-id", runId);
  setResponseHeader(event, "x-tail-index", String(await readable.getTailIndex()));
  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "x-vercel-ai-ui-message-stream", "v1");

  return readable
    .pipeThrough(new JsonToSseTransformStream() as unknown as TransformStream<
      UIMessageChunk,
      string
    >)
    .pipeThrough(new TextEncoderStream());
});
