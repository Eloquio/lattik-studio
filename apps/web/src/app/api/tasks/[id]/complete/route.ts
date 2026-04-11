import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { completeTask, tryCompleteRequest } from "@/lib/task-queue";
import { parseJsonBody } from "@/lib/api-validation";

const completeBodySchema = z.object({
  result: z.unknown().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await parseJsonBody(req, completeBodySchema);
  if (body instanceof Response) return body;

  const row = await completeTask(id, body.result);
  if (!row) {
    return Response.json(
      { error: "Task not found or not in claimed status" },
      { status: 404 }
    );
  }

  // Check if all tasks for this request are now done
  await tryCompleteRequest(row.requestId);

  return Response.json(row);
}
