import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { getRequest, addRequestMessage } from "@/lib/run-queue";
import { parseJsonBody } from "@/lib/api-validation";

const messageBodySchema = z.object({
  role: z.enum(["planner", "human"]),
  content: z.string().min(1).max(8000),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
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
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await parseJsonBody(req, messageBodySchema);
  if (body instanceof Response) return body;

  const row = await addRequestMessage(id, body.role, body.content);
  if (!row) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(row);
}
