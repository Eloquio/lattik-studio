import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { failTask, tryCompleteRequest } from "@/lib/task-queue";
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

  const row = await failTask(id, body.error, auth.workerId);
  if (!row) {
    return Response.json(
      { error: "Task not found, not in claimed status, or not owned by this worker" },
      { status: 404 },
    );
  }

  await tryCompleteRequest(row.requestId);

  return Response.json(row);
}
