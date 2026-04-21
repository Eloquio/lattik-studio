import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { claimTask } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";
import { touchWorkerHeartbeat } from "@/lib/worker-tokens";

const claimBodySchema = z.object({
  // Optional filter: claim only a task for this agent id. Workers that are
  // willing to execute any agent role omit this and get the oldest pending
  // task.
  agentId: z.string().min(1).optional(),
  // Cap at 1 hour so a buggy caller can't pin tasks indefinitely.
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1000)
    .optional(),
});

export async function POST(req: Request) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  // Heartbeat rides every poll — even empty claims (204) prove the worker
  // is alive. Touch first so a slow claimTask can't starve liveness signal.
  await touchWorkerHeartbeat(auth.workerId);

  const body = await parseJsonBody(req, claimBodySchema);
  if (body instanceof Response) return body;

  const row = await claimTask({
    agentId: body.agentId,
    claimedBy: auth.workerId,
    timeoutMs: body.timeoutMs,
  });

  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
