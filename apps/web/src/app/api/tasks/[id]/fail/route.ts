import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { failTask, tryCompleteRequest } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";

const failBodySchema = z.object({
  error: z.string().min(1).max(4000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await parseJsonBody(req, failBodySchema);
  if (body instanceof Response) return body;

  const row = await failTask(id, body.error);
  if (!row) {
    return Response.json(
      { error: "Task not found or not in claimed status" },
      { status: 404 },
    );
  }

  // Check if all remaining tasks are done/failed
  await tryCompleteRequest(row.requestId);

  return Response.json(row);
}
