import { requireTaskAuth } from "@/lib/bearer-auth";
import { completeRequest } from "@/lib/run-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const row = await completeRequest(id);
  if (!row) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(row);
}
