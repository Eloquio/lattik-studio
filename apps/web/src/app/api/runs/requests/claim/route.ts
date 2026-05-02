import { requireWorkerAuth } from "@/lib/bearer-auth";
import { claimRequest } from "@/lib/run-queue";
import { touchWorkerHeartbeat } from "@/lib/worker-tokens";

/**
 * Atomically lock the oldest pending request to the authenticated worker.
 * The Worker Node inspects the request's tasks state and dispatches its
 * Planner Agent (no tasks yet) or Executor Agent (planned, pending tasks).
 */
export async function POST(req: Request) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  // Heartbeat on every poll, regardless of claim outcome — empty polls
  // still prove the worker is alive.
  await touchWorkerHeartbeat(auth.workerId);

  const row = await claimRequest(auth.workerId);
  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
