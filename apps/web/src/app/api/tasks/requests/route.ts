import { requireTaskAuth } from "@/lib/task-auth";
import { createRequest, listRequests } from "@/lib/task-queue";
import type { RequestSource } from "@/db/schema";

export async function GET(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const status = url.searchParams.get("status") as Parameters<typeof listRequests>[0] extends { status?: infer S } ? S : never;
  const limit = url.searchParams.get("limit");

  const rows = await listRequests({
    status: status ?? undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  });
  return Response.json(rows);
}

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  const body = await req.json() as {
    source: RequestSource;
    description: string;
    context?: unknown;
  };

  if (!body.source || !body.description) {
    return Response.json(
      { error: "source and description are required" },
      { status: 400 }
    );
  }

  const row = await createRequest(body.source, body.description, body.context);
  return Response.json(row, { status: 201 });
}
