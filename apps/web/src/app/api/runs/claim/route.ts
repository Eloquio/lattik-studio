import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { claimRun } from "@/lib/run-queue";
import { parseJsonBody } from "@/lib/api-validation";
import { touchWorkerHeartbeat } from "@/lib/worker-tokens";

const claimBodySchema = z.object({
  // Optional filter: claim only a task whose skill matches. Workers willing
  // to execute any skill omit this and get the oldest pending task.
  skillId: z.string().min(1).optional(),
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
  // is alive. Touch first so a slow claimRun can't starve liveness signal.
  await touchWorkerHeartbeat(auth.workerId);

  const body = await parseJsonBody(req, claimBodySchema);
  if (body instanceof Response) return body;

  const row = await claimRun({
    skillId: body.skillId,
    claimedBy: auth.workerId,
    timeoutMs: body.timeoutMs,
  });

  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
