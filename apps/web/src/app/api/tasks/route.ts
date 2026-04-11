import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { createTask, listTasks } from "@/lib/task-queue";
import {
  MAX_LIMIT,
  parseJsonBody,
  taskStatusSchema,
} from "@/lib/api-validation";

const createTaskBodySchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string().min(1).max(4000),
  doneCriteria: z.string().min(1).max(4000),
  status: z.enum(["draft", "pending"]).optional(),
});

export async function GET(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId") ?? undefined;
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");

  const statusParsed = statusParam
    ? taskStatusSchema.safeParse(statusParam)
    : null;
  if (statusParsed && !statusParsed.success) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return Response.json(
        { error: `limit must be an integer in [1, ${MAX_LIMIT}]` },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  const rows = await listTasks({
    requestId,
    agentId,
    status: statusParsed?.data,
    limit,
  });
  return Response.json(rows);
}

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody(req, createTaskBodySchema);
  if (body instanceof Response) return body;

  const row = await createTask(
    body.requestId,
    body.agentId,
    body.description,
    body.doneCriteria,
    body.status,
  );
  return Response.json(row, { status: 201 });
}
