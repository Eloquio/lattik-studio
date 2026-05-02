/**
 * Database-backed run queue operations.
 *
 * Two-level model: requests (raw work orders) and runs (broken-down work).
 * The planner agent claims requests and creates runs; operator agents claim
 * and execute runs. Atomic claiming uses FOR UPDATE SKIP LOCKED to prevent
 * contention between concurrent agents.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import type {
  RequestSource,
  RequestStatus,
  RunStatus,
} from "@/db/schema";

/**
 * Minimum surface of a drizzle client needed by createRequest's transactional
 * caller — satisfied by both the top-level db returned from getDb() and by the
 * tx object passed into db.transaction(). Typed as a utility rather than
 * importing drizzle's PgTransaction so we don't couple the helper to a
 * specific driver.
 */
type DbLike = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Request operations
// ---------------------------------------------------------------------------

export async function createRequest(
  source: RequestSource,
  description: string,
  context?: unknown,
  options?: { skillId?: string; status?: RequestStatus; client?: DbLike }
) {
  const client = options?.client ?? getDb();
  const [row] = await client
    .insert(schema.requests)
    .values({
      source,
      description,
      context,
      skillId: options?.skillId,
      status: options?.status,
    })
    .returning();
  return row;
}

/**
 * How long a worker is expected to hold a claim on a request before it is
 * considered stuck. Matches the cron-driven stale-reset pass.
 */
export const REQUEST_STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function claimRequest(claimedBy: string, timeoutMs: number = REQUEST_STALE_TIMEOUT_MS) {
  const db = getDb();
  const staleAt = new Date(Date.now() + timeoutMs).toISOString();

  // Atomic claim: pick the oldest pending request, move it to "planning",
  // and lock it to this claimer. FOR UPDATE SKIP LOCKED lets concurrent
  // workers claim different requests without contending. The Worker Node
  // dispatches Planner or Executor based on the request's runs state, not
  // a pre-assigned agent column.
  const result = await db.execute<{
    id: string;
    source: RequestSource;
    description: string;
    context: unknown;
    messages: { role: "planner" | "human"; content: string; timestamp: string }[];
    skill_id: string | null;
    claimed_by: string | null;
    status: RequestStatus;
    stale_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(sql`
    UPDATE request
    SET status = 'planning',
        claimed_by = ${claimedBy},
        stale_at = ${staleAt}::timestamptz,
        updated_at = now()
    WHERE id = (
      SELECT id FROM request
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return result[0] ?? null;
}

/**
 * Reset any request whose claim has expired. Mirrors the run-level stale
 * reset in claimRun. Returns the number of rows released so the cron can
 * log it. Run from /api/cron/process-tasks.
 */
export async function resetStaleRequests(): Promise<number> {
  const db = getDb();
  const result = await db.execute<{ id: string }>(sql`
    UPDATE request
    SET status = 'pending', claimed_by = NULL, stale_at = NULL, updated_at = now()
    WHERE status = 'planning' AND stale_at < now()
    RETURNING id
  `);
  return result.length;
}

/**
 * Hard cap on the number of messages persisted per request. The JSONB array
 * grows on every append (full-row rewrite in Postgres), so we keep only the
 * most recent N — enough context for the planner to reason about the
 * conversation without bloating the row into query-plan territory.
 */
const MAX_REQUEST_MESSAGES = 200;

export async function addRequestMessage(
  id: string,
  role: "planner" | "human",
  content: string
) {
  const db = getDb();
  const message = { role, content, timestamp: new Date().toISOString() };
  // Append-and-trim in one UPDATE: concatenate the new message, then keep
  // only the tail slice. jsonb `||` is O(n) so capping avoids unbounded
  // row growth for long-running requests.
  const [row] = await db
    .update(schema.requests)
    .set({
      messages: sql`(
        SELECT jsonb_agg(m)
        FROM jsonb_array_elements(
          ${schema.requests.messages} || ${JSON.stringify([message])}::jsonb
        ) WITH ORDINALITY AS t(m, ord)
        WHERE ord > GREATEST(
          jsonb_array_length(${schema.requests.messages}) + 1 - ${MAX_REQUEST_MESSAGES},
          0
        )
      )`,
      updatedAt: new Date(),
    })
    .where(eq(schema.requests.id, id))
    .returning();
  return row;
}

export async function submitRequestForApproval(id: string) {
  const db = getDb();
  const [row] = await db
    .update(schema.requests)
    .set({ status: "awaiting_approval", updatedAt: new Date() })
    .where(
      and(
        eq(schema.requests.id, id),
        eq(schema.requests.status, "planning")
      )
    )
    .returning();
  return row;
}

export async function approveRequest(id: string) {
  const db = getDb();

  // Promote all draft runs to pending
  await db
    .update(schema.runs)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.runs.requestId, id),
        eq(schema.runs.status, "draft")
      )
    );

  const [row] = await db
    .update(schema.requests)
    .set({ status: "approved", updatedAt: new Date() })
    .where(
      and(
        eq(schema.requests.id, id),
        eq(schema.requests.status, "awaiting_approval")
      )
    )
    .returning();
  return row;
}

/**
 * Auto-approve a request (for skills with auto_approve). Sets status directly
 * to "approved" and promotes all draft runs to "pending" in one go.
 */
export async function autoApproveRequest(id: string) {
  const db = getDb();

  await db
    .update(schema.runs)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.runs.requestId, id),
        eq(schema.runs.status, "draft")
      )
    );

  const [row] = await db
    .update(schema.requests)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(schema.requests.id, id))
    .returning();
  return row;
}

export async function completeRequest(id: string) {
  const db = getDb();
  const [row] = await db
    .update(schema.requests)
    .set({ status: "done", updatedAt: new Date() })
    .where(eq(schema.requests.id, id))
    .returning();
  return row;
}

export async function failRequest(id: string, error: string) {
  const db = getDb();

  // Add error as a planner message so it's visible in the conversation
  await addRequestMessage(id, "planner", `Error: ${error}`);

  const [row] = await db
    .update(schema.requests)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(schema.requests.id, id))
    .returning();
  return row;
}

export async function getRequest(id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.id, id));
  return row ?? null;
}

export async function listRequests(options?: {
  status?: RequestStatus;
  limit?: number;
}) {
  const db = getDb();
  const conditions = [];
  if (options?.status) {
    conditions.push(eq(schema.requests.status, options.status));
  }
  return db
    .select()
    .from(schema.requests)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(schema.requests.createdAt)
    .limit(options?.limit ?? 50);
}

// ---------------------------------------------------------------------------
// Run operations
// ---------------------------------------------------------------------------

export async function createRun(
  requestId: string,
  skillId: string,
  description: string,
  doneCriteria: string,
  status: "draft" | "pending" = "draft",
) {
  const db = getDb();
  const [row] = await db
    .insert(schema.runs)
    .values({
      requestId,
      skillId,
      description,
      doneCriteria,
      status,
    })
    .returning();
  return row;
}

/**
 * Stale-claim timeout for any run. A claim that hasn't completed within this
 * window is released back to `pending` for another worker. Per-skill overrides
 * (via SKILL.md frontmatter) are intentionally deferred — revisit when a real
 * skill needs longer than 5 minutes.
 */
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function claimRun(options: {
  skillId?: string;
  claimedBy: string;
  timeoutMs?: number;
}) {
  const db = getDb();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleAt = new Date(Date.now() + timeoutMs).toISOString();

  // Build the skill filter clause
  const skillFilter = options.skillId
    ? sql`AND skill_id = ${options.skillId}`
    : sql``;

  // Two-step atomic operation:
  // 1. Reset any stale claimed runs back to pending
  // 2. Claim the oldest pending run
  await db.execute(sql`
    UPDATE run
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, stale_at = NULL
    WHERE status = 'claimed' AND stale_at < now()
  `);

  const result = await db.execute<{
    id: string;
    request_id: string;
    skill_id: string;
    description: string;
    done_criteria: string;
    status: RunStatus;
    args: Record<string, unknown> | null;
    claimed_by: string | null;
    result: unknown;
    error: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    tool_call_count: number | null;
    created_at: Date;
    claimed_at: Date | null;
    stale_at: Date | null;
    completed_at: Date | null;
  }>(sql`
    UPDATE run
    SET status = 'claimed',
        claimed_by = ${options.claimedBy},
        claimed_at = now(),
        stale_at = ${staleAt}::timestamptz
    WHERE id = (
      SELECT id FROM run
      WHERE status = 'pending' ${skillFilter}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return result[0] ?? null;
}

/**
 * Claim one pending run that belongs to a specific request. Used by the
 * Worker Node after it has claimed a Request and wants to pick exactly one
 * of that request's planned runs. Distinct from claimRun, which selects
 * across all requests and is used by older worker shapes.
 */
export async function claimRunForRequest(options: {
  requestId: string;
  claimedBy: string;
  timeoutMs?: number;
}) {
  const db = getDb();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleAt = new Date(Date.now() + timeoutMs).toISOString();

  // Two-step atomic operation:
  // 1. Reset any stale claimed runs back to pending (same as claimRun).
  // 2. Claim the oldest pending run scoped to this request.
  await db.execute(sql`
    UPDATE run
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, stale_at = NULL
    WHERE status = 'claimed' AND stale_at < now()
  `);

  const result = await db.execute<{
    id: string;
    request_id: string;
    skill_id: string;
    description: string;
    done_criteria: string;
    status: RunStatus;
    args: Record<string, unknown> | null;
    claimed_by: string | null;
    result: unknown;
    error: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    tool_call_count: number | null;
    created_at: Date;
    claimed_at: Date | null;
    stale_at: Date | null;
    completed_at: Date | null;
  }>(sql`
    UPDATE run
    SET status = 'claimed',
        claimed_by = ${options.claimedBy},
        claimed_at = now(),
        stale_at = ${staleAt}::timestamptz
    WHERE id = (
      SELECT id FROM run
      WHERE status = 'pending' AND request_id = ${options.requestId}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return result[0] ?? null;
}

export interface CompleteRunOptions {
  result?: unknown;
  requireClaimedBy?: string;
  metrics?: {
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    toolCallCount?: number | null;
  };
}

export async function completeRun(id: string, options: CompleteRunOptions = {}) {
  const db = getDb();
  const conditions = [
    eq(schema.runs.id, id),
    eq(schema.runs.status, "claimed"),
  ];
  if (options.requireClaimedBy !== undefined) {
    conditions.push(eq(schema.runs.claimedBy, options.requireClaimedBy));
  }
  const [row] = await db
    .update(schema.runs)
    .set({
      status: "done",
      result: options.result ?? null,
      completedAt: new Date(),
      ...(options.metrics?.model !== undefined && { model: options.metrics.model }),
      ...(options.metrics?.inputTokens !== undefined && { inputTokens: options.metrics.inputTokens }),
      ...(options.metrics?.outputTokens !== undefined && { outputTokens: options.metrics.outputTokens }),
      ...(options.metrics?.toolCallCount !== undefined && { toolCallCount: options.metrics.toolCallCount }),
    })
    .where(and(...conditions))
    .returning();
  return row;
}

export interface FailRunOptions {
  requireClaimedBy?: string;
  metrics?: CompleteRunOptions["metrics"];
}

export async function failRun(
  id: string,
  error: string,
  options: FailRunOptions = {},
) {
  const db = getDb();
  const conditions = [
    eq(schema.runs.id, id),
    eq(schema.runs.status, "claimed"),
  ];
  if (options.requireClaimedBy !== undefined) {
    conditions.push(eq(schema.runs.claimedBy, options.requireClaimedBy));
  }
  const [row] = await db
    .update(schema.runs)
    .set({
      status: "failed",
      error,
      completedAt: new Date(),
      ...(options.metrics?.model !== undefined && { model: options.metrics.model }),
      ...(options.metrics?.inputTokens !== undefined && { inputTokens: options.metrics.inputTokens }),
      ...(options.metrics?.outputTokens !== undefined && { outputTokens: options.metrics.outputTokens }),
      ...(options.metrics?.toolCallCount !== undefined && { toolCallCount: options.metrics.toolCallCount }),
    })
    .where(and(...conditions))
    .returning();
  return row;
}

export async function getRun(id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, id));
  return row ?? null;
}

export async function listRuns(options?: {
  requestId?: string;
  skillId?: string;
  status?: RunStatus;
  limit?: number;
}) {
  const db = getDb();
  const conditions = [];
  if (options?.requestId) {
    conditions.push(eq(schema.runs.requestId, options.requestId));
  }
  if (options?.skillId) {
    conditions.push(eq(schema.runs.skillId, options.skillId));
  }
  if (options?.status) {
    conditions.push(eq(schema.runs.status, options.status));
  }
  return db
    .select()
    .from(schema.runs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(schema.runs.createdAt)
    .limit(options?.limit ?? 50);
}

/**
 * Check if all runs for a request are done. If so, mark the request as done.
 * Returns true if the request was completed.
 */
export async function tryCompleteRequest(requestId: string) {
  const db = getDb();
  const runRows = await db
    .select({
      skillId: schema.runs.skillId,
      description: schema.runs.description,
      status: schema.runs.status,
      error: schema.runs.error,
    })
    .from(schema.runs)
    .where(eq(schema.runs.requestId, requestId));

  if (runRows.length === 0) return false;

  const allDone = runRows.every((r) => r.status === "done");
  const anyFailed = runRows.some((r) => r.status === "failed");

  if (allDone) {
    await completeRequest(requestId);
    return true;
  }
  if (anyFailed && !runRows.some((r) => r.status === "pending" || r.status === "claimed")) {
    const failed = runRows.filter((r) => r.status === "failed");
    const lines = failed.map(
      (r) => `• ${r.skillId}: ${r.error ?? "(no error message)"}`,
    );
    const summary = `${failed.length} of ${runRows.length} run${
      runRows.length === 1 ? "" : "s"
    } failed:\n${lines.join("\n")}`;
    await failRequest(requestId, summary);
    return true;
  }
  return false;
}
