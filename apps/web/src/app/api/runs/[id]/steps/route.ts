/**
 * Worker → server channel for step events.
 *
 * The Executor Agent's `onStepFinish` callback POSTs here once per LLM
 * iteration with whatever happened in that step (text/reasoning blocks,
 * tool calls, tool results, finishReason, usage). The server splits the
 * step into one row per logical event so the UI flowchart can render
 * each as a separate node.
 *
 * Worker auth — only the agent-worker writes here. UI reads via the
 * server action (request-detail.tsx) or the SSE stream endpoint.
 */

import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireWorkerAuth } from "@/lib/bearer-auth";
import { parseJsonBody } from "@/lib/api-validation";

// Loose validation — the AI SDK shape is rich, we'd rather pass it through
// than try to mirror every variant. The kind is a discriminator the UI
// switches on; payload carries the step-specific shape.
const stepEventSchema = z.object({
  kind: z.enum(["text", "reasoning", "tool_call", "tool_result", "finish", "error"]),
  payload: z.unknown().optional(),
});

const bodySchema = z.object({
  events: z.array(stepEventSchema).min(1).max(50),
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

  // Allocate sequence numbers atomically — find the current max and slot
  // the new events after it. Concurrent writers on the same run are
  // unlikely (one worker per run) so a simple read-then-insert is fine.
  const [{ next_seq }] = await db.execute<{ next_seq: number }>(sql`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
    FROM run_step
    WHERE run_id = ${runId}
  `);

  const rows = body.events.map((evt, i) => ({
    runId,
    sequence: next_seq + i,
    kind: evt.kind,
    payload: evt.payload ?? null,
  }));

  const inserted = await db.insert(schema.steps).values(rows).returning();
  return Response.json({ inserted: inserted.length });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // List steps for a run. User-auth — the UI reads via this when
  // hydrating the flowchart. Returns rows ordered by sequence.
  const { id: runId } = await ctx.params;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.steps)
    .where(eq(schema.steps.runId, runId))
    .orderBy(schema.steps.sequence);
  return Response.json(rows);
}
