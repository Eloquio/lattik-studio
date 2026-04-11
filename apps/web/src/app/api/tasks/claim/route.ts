import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { claimTask } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";

const claimBodySchema = z.object({
  agentId: z.string().min(1).optional(),
  claimedBy: z.string().min(1),
  // Cap at 1 hour so a buggy caller can't pin tasks indefinitely.
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1000)
    .optional(),
});

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody(req, claimBodySchema);
  if (body instanceof Response) return body;

  const row = await claimTask({
    agentId: body.agentId,
    claimedBy: body.claimedBy,
    timeoutMs: body.timeoutMs,
  });

  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
