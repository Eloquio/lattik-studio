/**
 * Per-worker bearer tokens for task-API auth.
 *
 * A *worker* is a fungible process that executes tasks. When a worker claims
 * a task, it reads the task's agent id and instantiates that agent to do the
 * work. Workers aren't pre-bound to specific agents — the assignment is a
 * property of the task, not the worker.
 *
 * Each worker still owns its own secret so a compromised process can be
 * revoked without rotating a fleet-wide token, and ownership of in-flight
 * claims is enforced via `task.claimed_by = workerId` at complete/fail time.
 *
 * Token format:
 *   - Generated secret: 32 random bytes encoded as hex.
 *   - Stored in DB: sha256(secret) in `worker.token_hash`.
 *   - Transmitted as: `Authorization: Bearer <workerId>:<secret>`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

/**
 * A worker is considered "live" if its last_seen_at falls within this window.
 * The worker polls every ~5s, so 30s tolerates a few missed polls before the
 * UI flips it to grey.
 */
export const WORKER_LIVENESS_WINDOW_MS = 30_000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Create or rotate a worker's token. If `id` already exists, this overwrites
 * the hash, name, and (if supplied) mode. Returns the plaintext secret —
 * callers must surface it to the user exactly once; it cannot be recovered
 * later.
 */
export async function registerWorker(input: {
  id: string;
  name: string;
  mode?: "cluster" | "host";
}): Promise<string> {
  const db = getDb();
  const secret = randomBytes(32).toString("hex");
  const tokenHash = hashSecret(secret);

  await db
    .insert(schema.workers)
    .values({
      id: input.id,
      name: input.name,
      tokenHash,
      ...(input.mode ? { mode: input.mode } : {}),
    })
    .onConflictDoUpdate({
      target: schema.workers.id,
      set: {
        name: input.name,
        tokenHash,
        ...(input.mode ? { mode: input.mode } : {}),
        updatedAt: new Date(),
      },
    });

  return secret;
}

/** Delete a worker — its old secret can no longer authenticate. */
export async function revokeWorker(id: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.workers).where(eq(schema.workers.id, id));
}

/**
 * Update a worker's `last_seen_at` to now. Called on every claim-endpoint
 * poll so the studio can tell live workers from dead ones. Non-throwing —
 * if the worker row was deleted between auth and this call, silently noop.
 */
export async function touchWorkerHeartbeat(id: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.workers)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.workers.id, id));
}

/**
 * Count of workers whose last_seen_at is within the liveness window. Feeds
 * the "N workers online" badge and the per-row live-pill on /settings/workers.
 */
export async function countActiveWorkers(): Promise<number> {
  const db = getDb();
  const threshold = new Date(Date.now() - WORKER_LIVENESS_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.workers)
    .where(gt(schema.workers.lastSeenAt, threshold));
  return row?.count ?? 0;
}

/**
 * Verify a presented `<workerId>:<secret>` pair. Returns the worker id on
 * success, or null on any failure (unknown worker, bad secret, etc.).
 */
export async function verifyWorkerToken(
  presented: string,
): Promise<string | null> {
  const sep = presented.indexOf(":");
  if (sep < 1 || sep === presented.length - 1) return null;
  const workerId = presented.slice(0, sep);
  const secret = presented.slice(sep + 1);

  const db = getDb();
  const [row] = await db
    .select({ tokenHash: schema.workers.tokenHash })
    .from(schema.workers)
    .where(eq(schema.workers.id, workerId))
    .limit(1);

  if (!row) return null;

  const presentedHash = hashSecret(secret);
  const a = Buffer.from(presentedHash, "hex");
  const b = Buffer.from(row.tokenHash, "hex");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return workerId;
}
