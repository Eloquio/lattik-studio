import { requireTaskAuth } from "@/lib/task-auth";
import { claimRequest } from "@/lib/task-queue";

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await req.json() as { claimedBy: string };
  if (!body.claimedBy) {
    return Response.json({ error: "claimedBy is required" }, { status: 400 });
  }

  const row = await claimRequest(body.claimedBy);
  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
