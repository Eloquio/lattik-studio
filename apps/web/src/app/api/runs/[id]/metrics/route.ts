/**
 * Per-run metrics writer.
 *
 * Worker → server channel for the aggregate metrics that get computed only
 * after the LLM agent finishes (totalUsage, tool call count, model). Called
 * once per run, AFTER finishSkill has already moved the row to done/failed —
 * so this endpoint deliberately doesn't check status. It's an unconditional
 * patch to the metrics columns on the run row.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { parseJsonBody } from "@/lib/api-validation";

const bodySchema = z.object({
  model: z.string().min(1).max(200).optional(),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  tool_call_count: z.number().int().min(0).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkerAuth(req);
  if (auth instanceof Response) return auth;

  const body = await parseJsonBody(req, bodySchema);
  if (body instanceof Response) return body;

  const { id: runId } = await ctx.params;
  const db = getDb();
  const [row] = await db
    .update(schema.runs)
    .set({
      ...(body.model !== undefined && { model: body.model }),
      ...(body.input_tokens !== undefined && { inputTokens: body.input_tokens }),
      ...(body.output_tokens !== undefined && { outputTokens: body.output_tokens }),
      ...(body.tool_call_count !== undefined && { toolCallCount: body.tool_call_count }),
    })
    .where(eq(schema.runs.id, runId))
    .returning();

  if (!row) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }
  return Response.json(row);
}
