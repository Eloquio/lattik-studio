import { requireTaskAuth } from "@/lib/task-auth";
import { failRequest } from "@/lib/task-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await req.json() as { error: string };
  if (!body.error) {
    return Response.json({ error: "error is required" }, { status: 400 });
  }

  const row = await failRequest(id, body.error);
  if (!row) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(row);
}
