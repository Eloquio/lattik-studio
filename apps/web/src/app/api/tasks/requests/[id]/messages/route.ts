import { requireTaskAuth } from "@/lib/task-auth";
import { getRequest, addRequestMessage } from "@/lib/task-queue";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const request = await getRequest(id);
  if (!request) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(request.messages);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await req.json() as {
    role: "planner" | "human";
    content: string;
  };

  if (!body.role || !body.content) {
    return Response.json(
      { error: "role and content are required" },
      { status: 400 }
    );
  }

  const row = await addRequestMessage(id, body.role, body.content);
  if (!row) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(row);
}
