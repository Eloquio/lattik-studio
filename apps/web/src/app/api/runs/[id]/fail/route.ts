import { z } from "zod";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { failRun, tryCompleteRequest } from "@/lib/run-queue";
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

  const row = await failRun(id, body.error, { requireClaimedBy: auth.workerId });
  if (!row) {
    return Response.json(
      { error: "Run not found, not in claimed status, or not owned by this worker" },
      { status: 404 },
    );
  }

  await tryCompleteRequest(row.requestId);

  return Response.json(row);
}
