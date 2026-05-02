import { requireTaskAuth } from "@/lib/bearer-auth";
import { approveRequest } from "@/lib/run-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const row = await approveRequest(id);
  if (!row) {
    return Response.json(
      { error: "Request not found or not awaiting approval" },
      { status: 404 }
    );
  }
  return Response.json(row);
}
