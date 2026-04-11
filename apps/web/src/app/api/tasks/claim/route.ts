import { requireTaskAuth } from "@/lib/task-auth";
import { claimTask } from "@/lib/task-queue";

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await req.json() as {
    agentId?: string;
    claimedBy: string;
    timeoutMs?: number;
  };

  if (!body.claimedBy) {
    return Response.json({ error: "claimedBy is required" }, { status: 400 });
  }

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
