import { requireWorkerAuth } from "@/lib/bearer-auth";
import { claimRequest } from "@/lib/task-queue";
import { touchWorkerHeartbeat } from "@/lib/worker-tokens";

/**
 * Atomically lock the oldest pending request to the authenticated worker.
 * The returned row's `agent_id` tells the caller what to do next:
 *   - null  → act as planner and decide which agent should work on it
 *   - set   → take that agent's role and execute the request directly
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
