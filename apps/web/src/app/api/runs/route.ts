import { z } from "zod";
import { requireTaskAuth, requireWorkerAuth } from "@/lib/bearer-auth";
import { createRun, listRuns } from "@/lib/run-queue";
import {
  MAX_LIMIT,
  parseJsonBody,
  runStatusSchema,
} from "@/lib/api-validation";

const createRunBodySchema = z.object({
  requestId: z.string().min(1),
  skillId: z.string().min(1),
  description: z.string().min(1).max(4000),
  doneCriteria: z.string().min(1).max(4000),
  status: z.enum(["draft", "pending"]).optional(),
});

export async function GET(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId") ?? undefined;
  const skillId = url.searchParams.get("skillId") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");

  const statusParsed = statusParam
    ? runStatusSchema.safeParse(statusParam)
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

  const rows = await listRuns({
    requestId,
    skillId,
    status: statusParsed?.data,
    limit,
  });
  return Response.json(rows);
}

export async function POST(req: Request) {
  // POST is the worker-side path used by emit-run. Authenticate as a
  // worker (per-worker bearer) rather than the legacy single-key task agent.
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  const body = await parseJsonBody(req, createRunBodySchema);
  if (body instanceof Response) return body;

  const row = await createRun(
    body.requestId,
    body.skillId,
    body.description,
    body.doneCriteria,
    body.status,
  );
  return Response.json(row, { status: 201 });
}
