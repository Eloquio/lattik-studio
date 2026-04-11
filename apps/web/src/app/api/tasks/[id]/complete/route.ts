import { requireTaskAuth } from "@/lib/task-auth";
import { completeTask, getTask, tryCompleteRequest } from "@/lib/task-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const { id } = await params;
  const body = await req.json() as { result?: unknown };

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
