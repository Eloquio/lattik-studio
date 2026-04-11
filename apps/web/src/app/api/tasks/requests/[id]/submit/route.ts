import { requireTaskAuth } from "@/lib/bearer-auth";
import { submitRequestForApproval } from "@/lib/task-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const row = await submitRequestForApproval(id);
  if (!row) {
    return Response.json(
      { error: "Request not found or not in planning status" },
      { status: 404 }
    );
  }
  return Response.json(row);
}
