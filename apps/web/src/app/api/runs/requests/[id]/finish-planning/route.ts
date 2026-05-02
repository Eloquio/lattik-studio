import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { parseJsonBody } from "@/lib/api-validation";
import {
  autoApproveRequest,
  failRequest,
  submitRequestForApproval,
} from "@/lib/run-queue";

/**
 * Finalize the planning step for a request. Called by the Worker Node's
 * Planner Agent after it has emitted runs (or decided no skill matches).
 *
 * Behavior:
 *   - `outcome: "failed"` → fail the request with the given reason.
 *   - default (`outcome: "completed"`):
 *     - If the request has zero runs → fail with "planner emitted no runs".
 *     - If any run is still `draft` → submit for human approval.
 *     - If all runs are `pending` → auto-approve.
 *
 * The mechanical inspection of run statuses (rather than letting the LLM
 * pass `auto_approve`) keeps the planner from having to reason about its own
 * insertions: emit_run already set each run's status from the skill's
 * `auto_approve` flag.
 */

const finishPlanningSchema = z.object({
  outcome: z.enum(["completed", "failed"]).optional().default("completed"),
  reason: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  const body = await parseJsonBody(req, finishPlanningSchema);
  if (body instanceof Response) return body;

  const { id: requestId } = await ctx.params;

  if (body.outcome === "failed") {
    const row = await failRequest(requestId, body.reason ?? "planner failed");
    return Response.json(row);
  }

  // outcome === "completed" — inspect the inserted tasks and pick a path.
  const db = getDb();
  const runs = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.requestId, requestId));

  if (runs.length === 0) {
    const row = await failRequest(
      requestId,
      body.reason ?? "planner emitted no runs",
    );
    return Response.json(row);
  }

  const anyDraft = runs.some((r) => r.status === "draft");
  const row = anyDraft
    ? await submitRequestForApproval(requestId)
    : await autoApproveRequest(requestId);
  return Response.json(row);
}
