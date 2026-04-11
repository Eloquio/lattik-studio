/**
 * Database-backed task queue operations.
 *
 * Two-level model: requests (raw work orders) and tasks (broken-down work).
 * The planner agent claims requests and creates tasks; operator agents claim
 * and execute tasks. Atomic claiming uses FOR UPDATE SKIP LOCKED to prevent
 * contention between concurrent agents.
 */

import { and, eq, sql, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import type {
  RequestSource,
  RequestStatus,
  TaskStatus,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Request operations
// ---------------------------------------------------------------------------

export async function createRequest(
  source: RequestSource,
  description: string,
  context?: unknown
) {
  const db = getDb();
  const [row] = await db
    .insert(schema.requests)
    .values({ source, description, context })
    .returning();
  return row;
}

export async function claimRequest(claimedBy: string) {
  const db = getDb();

  // Atomic claim: pick the oldest pending request and set status to "planning".
  // FOR UPDATE SKIP LOCKED prevents concurrent planners from contending.
  const result = await db.execute<{
    id: string;
    source: RequestSource;
    description: string;
    context: unknown;
    messages: { role: "planner" | "human"; content: string; timestamp: string }[];
    skill_id: string | null;
    status: RequestStatus;
    created_at: Date;
    updated_at: Date;
  }>(sql`
    UPDATE request
    SET status = 'planning', updated_at = now()
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

export async function addRequestMessage(
  id: string,
  role: "planner" | "human",
  content: string
) {
  const db = getDb();
  const message = { role, content, timestamp: new Date().toISOString() };
  const [row] = await db
    .update(schema.requests)
    .set({
      messages: sql`${schema.requests.messages} || ${JSON.stringify([message])}::jsonb`,
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

  // Promote all draft tasks to pending
  await db
    .update(schema.tasks)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.tasks.requestId, id),
        eq(schema.tasks.status, "draft")
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
 * to "approved" and promotes all draft tasks to "pending" in one go.
 */
export async function autoApproveRequest(id: string) {
  const db = getDb();

  await db
    .update(schema.tasks)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.tasks.requestId, id),
        eq(schema.tasks.status, "draft")
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
// Task operations
// ---------------------------------------------------------------------------

export async function createTask(
  requestId: string,
  agentId: string,
  description: string,
  doneCriteria: string,
  status: "draft" | "pending" = "draft"
) {
  const db = getDb();
  const [row] = await db
    .insert(schema.tasks)
    .values({ requestId, agentId, description, doneCriteria, status })
    .returning();
  return row;
}

const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function claimTask(options: {
  agentId?: string;
  claimedBy: string;
  timeoutMs?: number;
}) {
  const db = getDb();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleAt = new Date(Date.now() + timeoutMs).toISOString();

  // Build the agent filter clause
  const agentFilter = options.agentId
    ? sql`AND agent_id = ${options.agentId}`
    : sql``;

  // Two-step atomic operation:
  // 1. Reset any stale claimed tasks back to pending
  // 2. Claim the oldest pending task
  await db.execute(sql`
    UPDATE task
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, stale_at = NULL
    WHERE status = 'claimed' AND stale_at < now()
  `);

  const result = await db.execute<{
    id: string;
    request_id: string;
    agent_id: string;
    description: string;
    done_criteria: string;
    status: TaskStatus;
    claimed_by: string | null;
    result: unknown;
    error: string | null;
    created_at: Date;
    claimed_at: Date | null;
    stale_at: Date | null;
    completed_at: Date | null;
  }>(sql`
    UPDATE task
    SET status = 'claimed',
        claimed_by = ${options.claimedBy},
        claimed_at = now(),
        stale_at = ${staleAt}::timestamptz
    WHERE id = (
      SELECT id FROM task
      WHERE status = 'pending' ${agentFilter}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return result[0] ?? null;
}

export async function completeTask(id: string, result?: unknown) {
  const db = getDb();
  const [row] = await db
    .update(schema.tasks)
    .set({
      status: "done",
      result: result ?? null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(schema.tasks.id, id),
        eq(schema.tasks.status, "claimed")
      )
    )
    .returning();
  return row;
}

export async function failTask(id: string, error: string) {
  const db = getDb();
  const [row] = await db
    .update(schema.tasks)
    .set({
      status: "failed",
      error,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(schema.tasks.id, id),
        eq(schema.tasks.status, "claimed")
      )
    )
    .returning();
  return row;
}

export async function getTask(id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  return row ?? null;
}

export async function listTasks(options?: {
  requestId?: string;
  agentId?: string;
  status?: TaskStatus;
  limit?: number;
}) {
  const db = getDb();
  const conditions = [];
  if (options?.requestId) {
    conditions.push(eq(schema.tasks.requestId, options.requestId));
  }
  if (options?.agentId) {
    conditions.push(eq(schema.tasks.agentId, options.agentId));
  }
  if (options?.status) {
    conditions.push(eq(schema.tasks.status, options.status));
  }
  return db
    .select()
    .from(schema.tasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(schema.tasks.createdAt)
    .limit(options?.limit ?? 50);
}

/**
 * Check if all tasks for a request are done. If so, mark the request as done.
 * Returns true if the request was completed.
 */
export async function tryCompleteRequest(requestId: string) {
  const db = getDb();
  const taskRows = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.requestId, requestId));

  if (taskRows.length === 0) return false;

  const allDone = taskRows.every((t) => t.status === "done");
  const anyFailed = taskRows.some((t) => t.status === "failed");

  if (allDone) {
    await completeRequest(requestId);
    return true;
  }
  if (anyFailed && !taskRows.some((t) => t.status === "pending" || t.status === "claimed")) {
    await failRequest(requestId, "One or more tasks failed");
    return true;
  }
  return false;
}
