import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { failRequest } from "@/lib/run-queue";
import { parseJsonBody } from "@/lib/api-validation";

const failBodySchema = z.object({
  error: z.string().min(1).max(4000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const body = await parseJsonBody(req, failBodySchema);
  if (body instanceof Response) return body;

  const row = await failRequest(id, body.error);
  if (!row) {
    return Response.json({ error: "Request not found" }, { status: 404 });
  }
  return Response.json(row);
}
