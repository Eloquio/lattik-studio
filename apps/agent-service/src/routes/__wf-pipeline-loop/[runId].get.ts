import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { getRun } from "workflow/api";
import type { LoopEvent } from "../../workflows/pipeline-manager-loop.js";

// Spike 5/6 reattach: reads the per-tool-durable loop's stream from a
// `?startIndex=N` cursor (negative-from-tail supported) and re-encodes
// each event as NDJSON. The same generic `__wf-stream/:runId` route
// works structurally but stringifies objects with `String()`, which
// produces "[object Object]" — typed-loop callers want the actual JSON
// shape.

export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: "Missing runId" });
  }
  const startIndexRaw = getQuery(event).startIndex;
  const startIndex =
    typeof startIndexRaw === "string" ? Number.parseInt(startIndexRaw, 10) : undefined;

  const run = getRun<unknown>(runId);
  const readable = run.getReadable<LoopEvent>(
    startIndex !== undefined && Number.isFinite(startIndex) ? { startIndex } : {},
  );

  setResponseHeader(event, "x-run-id", runId);
  setResponseHeader(event, "x-tail-index", String(await readable.getTailIndex()));
  setResponseHeader(event, "content-type", "application/x-ndjson");
  setResponseHeader(event, "cache-control", "no-cache");

  const encoder = new TextEncoder();
  return readable.pipeThrough(
    new TransformStream<LoopEvent, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
      },
    }),
  );
});
