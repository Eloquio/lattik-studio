import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { completeTask, tryCompleteRequest } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";

const completeBodySchema = z.object({
  result: z.unknown().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const body = await parseJsonBody(req, completeBodySchema);
  if (body instanceof Response) return body;

  const row = await completeTask(id, body.result, auth.workerId);
  if (!row) {
    return Response.json(
      { error: "Task not found, not in claimed status, or not owned by this worker" },
      { status: 404 }
    );
  }

  await tryCompleteRequest(row.requestId);

  return Response.json(row);
}
