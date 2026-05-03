import {
  defineEventHandler,
  setResponseHeader,
  readValidatedBody,
  createError,
} from "h3";
import { z } from "zod";
import { start } from "workflow/api";
import { aiStreamWorkflow } from "../workflows/ai-stream.js";

// Spike 3 (start side): kicks off an AI streamText workflow run and pipes
// the run's readable stream straight back to the HTTP client. Reuses the
// reattach contract from Spike 2 — a second client can reconnect via
// GET /__wf-stream/:runId because the underlying stream is keyed by runId,
// not by the producer.

const bodySchema = z.object({
  modelId: z.string().default("anthropic/claude-haiku-4.5"),
  prompt: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, (raw) => bodySchema.safeParse(raw));
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${body.error.message}`,
    });
  }

  const run = await start(aiStreamWorkflow, [body.data]);
  setResponseHeader(event, "x-run-id", run.runId);
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-cache");

  const encoder = new TextEncoder();
  return run.readable.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  );
});
