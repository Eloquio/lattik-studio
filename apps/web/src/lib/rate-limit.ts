/**
 * Postgres-backed sliding-window rate limiter.
 *
 * Uses an UPSERT with `ON CONFLICT DO UPDATE` to atomically increment a
 * counter for a given key. The counter resets when its window expires. Because
 * state lives in the database, the limit holds across server restarts and
 * across multiple serverless instances — unlike an in-process Map, which an
 * attacker can defeat by triggering process recycles.
 *
 * For very high request volumes a Redis token bucket would be cheaper, but at
 * Lattik Studio's current scale Postgres is more than fast enough and saves us
 * from running another piece of infrastructure.
 */

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function rateLimit(
  key: string,
  { maxRequests = 30, windowMs = 60_000 }: { maxRequests?: number; windowMs?: number } = {}
): Promise<RateLimitResult> {
  const db = getDb();
  const now = new Date();
  const newResetAt = new Date(now.getTime() + windowMs);
  // postgres-js can't bind raw Date objects through drizzle's `sql` template,
  // so pre-serialize to ISO strings for the CASE expressions below.
  const nowIso = now.toISOString();
  const newResetAtIso = newResetAt.toISOString();

  // Atomic upsert: if no row exists, insert with count=1. If a row exists and
  // its window is still active, increment count. If the existing window has
  // already expired, reset count to 1 and start a new window. All three cases
  // happen in a single SQL statement so concurrent requests can't race.
  const [row] = await db
    .insert(schema.rateLimits)
    .values({ key, count: 1, resetAt: newResetAt })
    .onConflictDoUpdate({
      target: schema.rateLimits.key,
      set: {
        count: sql`CASE WHEN ${schema.rateLimits.resetAt} > ${nowIso} THEN ${schema.rateLimits.count} + 1 ELSE 1 END`,
        resetAt: sql`CASE WHEN ${schema.rateLimits.resetAt} > ${nowIso} THEN ${schema.rateLimits.resetAt} ELSE ${newResetAtIso} END`,
      },
    })
    .returning({
      count: schema.rateLimits.count,
      resetAt: schema.rateLimits.resetAt,
    });

  const count = row?.count ?? 1;
  const resetAt = row?.resetAt ?? newResetAt;
  const allowed = count <= maxRequests;
  return {
    allowed,
    remaining: Math.max(0, maxRequests - count),
    resetAt: resetAt.getTime(),
  };
}
