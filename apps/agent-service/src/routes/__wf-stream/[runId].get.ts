import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  setResponseHeader,
  createError,
} from "h3";
import { getRun } from "workflow/api";
import { assertRunOwner } from "../../lib/workflow-runs.js";

// Spike 2 (reattach side): given an existing runId, return the same readable
// stream the original POST consumed — optionally starting from `?startIndex=N`
// so reconnecting clients skip chunks they've already seen. Negative indices
// count from the tail (e.g. -3 = last 3 chunks).
//
// Auth via `attachAuth` middleware + per-run ownership check.

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

  const run = getRun<{ ticksWritten: number }>(runId);
  const readable = run.getReadable<string>(
    startIndex !== undefined && Number.isFinite(startIndex) ? { startIndex } : {},
  );

  setResponseHeader(event, "x-run-id", runId);
  setResponseHeader(event, "x-tail-index", String(await readable.getTailIndex()));
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-cache");

  const encoder = new TextEncoder();
  return readable.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(`${chunk}\n`));
      },
    }),
  );
});
