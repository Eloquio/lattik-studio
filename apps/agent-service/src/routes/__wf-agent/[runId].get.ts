import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { getRun } from "workflow/api";
import type { LoopEvent } from "../../workflows/agent-loop.js";
import { assertRunOwner } from "../../lib/workflow-runs.js";

// Reattach for the generalized agent loop. Same `?startIndex=N` contract
// as the other workflow routes, NDJSON-encoded.
//
// Auth is enforced by `attachAuth` middleware + per-run ownership
// check against the `workflow_run` table written when the run was
// started. Foreign-owned runIds 404 to avoid leaking existence.

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
