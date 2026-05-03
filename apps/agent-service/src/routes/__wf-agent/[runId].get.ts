import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { getRun } from "workflow/api";
import type { LoopEvent } from "../../workflows/agent-loop.js";

// Reattach for the generalized agent loop. Same `?startIndex=N` contract
// as the other workflow routes, NDJSON-encoded.
//
// Auth is enforced by `attachAuth` middleware (trusted client + asserted
// `X-User-Id`). TODO: per-run ownership — currently any authenticated
// caller with a known runId can read its stream. A real check needs a
// `runId → ownerUserId` mapping (committed when the workflow starts) so
// reattach can compare against `event.context.auth.userId`. In practice
// runIds are only handed back to the original POST caller, so this is a
// defense-in-depth gap rather than an open door.

export default defineEventHandler(async (event) => {
  if (!event.context.auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }
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
