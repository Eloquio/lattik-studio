import { requireTaskAuth } from "@/lib/task-auth";
import { createTask, listTasks } from "@/lib/task-queue";
import type { TaskStatus } from "@/db/schema";

export async function GET(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId") ?? undefined;
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const status = (url.searchParams.get("status") as TaskStatus) ?? undefined;
  const limit = url.searchParams.get("limit");

  const rows = await listTasks({
    requestId,
    agentId,
    status,
    limit: limit ? parseInt(limit, 10) : undefined,
  });
  return Response.json(rows);
}

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await req.json() as {
    requestId: string;
    agentId: string;
    description: string;
    doneCriteria: string;
    status?: "draft" | "pending";
  };

  if (!body.requestId || !body.agentId || !body.description || !body.doneCriteria) {
    return Response.json(
      { error: "requestId, agentId, description, and doneCriteria are required" },
      { status: 400 }
    );
  }

  const row = await createTask(
    body.requestId,
    body.agentId,
    body.description,
    body.doneCriteria,
    body.status
  );
  return Response.json(row, { status: 201 });
}
