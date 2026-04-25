import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { claimTaskForRequest } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";
import { touchWorkerHeartbeat } from "@/lib/worker-tokens";

/**
 * Atomically claim one pending task scoped to the given request.
 *
 * Used by the Worker Node's Executor branch: after the Worker Node has
 * claimed a Request via /api/tasks/requests/claim, it calls this endpoint
 * to pull exactly one of that request's planned tasks. Without the request
 * scope, the worker might claim a task from an unrelated request and stall
 * the one it currently holds.
 */

const claimBodySchema = z.object({
  // Cap at 1 hour so a buggy caller can't pin tasks indefinitely.
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1000)
    .optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  // Heartbeat on every poll, regardless of claim outcome.
  await touchWorkerHeartbeat(auth.workerId);

  const body = await parseJsonBody(req, claimBodySchema);
  if (body instanceof Response) return body;

  const { id: requestId } = await ctx.params;
  const row = await claimTaskForRequest({
    requestId,
    claimedBy: auth.workerId,
    timeoutMs: body.timeoutMs,
  });

  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
