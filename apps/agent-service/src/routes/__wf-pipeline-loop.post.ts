import {
  defineEventHandler,
  setResponseHeader,
  readValidatedBody,
  createError,
} from "h3";
import { z } from "zod";
import type { UIMessage } from "ai";
import { start } from "workflow/api";
import { pipelineManagerLoopWorkflow } from "../workflows/pipeline-manager-loop.js";

// Spike 5 (start side): kicks off the per-tool-durable Pipeline Manager
// loop. The workflow body drives the tool loop and emits structured events
// (model-finish / tool-call / tool-result / loop-finish) into the writable
// — we surface them here as newline-delimited JSON for easy curl-side
// inspection. A real client would consume these as SSE or a UI message
// stream.

const bodySchema = z.object({
  messages: z.array(z.unknown()),
});

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, (raw) => bodySchema.safeParse(raw));
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${body.error.message}`,
    });
  }

  const run = await start(pipelineManagerLoopWorkflow, [
    { uiMessages: body.data.messages as UIMessage[] },
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
