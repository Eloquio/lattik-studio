import { z } from "zod";
import { requireTaskAuth } from "@/lib/bearer-auth";
import { createRequest, listRequests } from "@/lib/run-queue";
import {
  MAX_LIMIT,
  parseJsonBody,
  requestStatusSchema,
} from "@/lib/api-validation";

const createRequestBodySchema = z.object({
  source: z.enum(["webhook", "human"]),
  description: z.string().min(1).max(4000),
  context: z.unknown().optional(),
});

export async function GET(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");

  const statusParsed = statusParam
    ? requestStatusSchema.safeParse(statusParam)
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

  const rows = await listRequests({
    status: statusParsed?.data,
    limit,
  });
  return Response.json(rows);
}

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody(req, createRequestBodySchema);
  if (body instanceof Response) return body;

  const row = await createRequest(body.source, body.description, body.context);
  return Response.json(row, { status: 201 });
}
