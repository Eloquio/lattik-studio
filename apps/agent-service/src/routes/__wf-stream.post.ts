import { defineEventHandler, setResponseHeader } from "h3";
import { start } from "workflow/api";
import { streamingWorkflow } from "../workflows/streaming.js";

// Spike 2 (start side): kicks off a streaming workflow run and pipes the
// run's readable stream straight back to the HTTP client. The runId is
// surfaced via a response header so a second client can reattach via the
// GET /__wf-stream/:runId route. Chunks are encoded as newline-separated
// text — fine for a smoke test, real consumers will use SSE / UI message
// chunks in Spike 3.

export default defineEventHandler(async (event) => {
  const run = await start(streamingWorkflow, []);
  setResponseHeader(event, "x-run-id", run.runId);
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-cache");

  const encoder = new TextEncoder();
  return run.readable.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(`${chunk}\n`));
      },
    }),
  );
});
