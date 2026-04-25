/**
 * Phase 1 verification script — heartbeat + stale-claim release on requests.
 *
 * Exercises:
 *   1. touchWorkerHeartbeat updates last_seen_at.
 *   2. countActiveWorkers reflects the 30s window.
 *   3. claimRequest sets stale_at.
 *   4. resetStaleRequests flips expired 'planning' rows back to 'pending'.
 *   5. POST /api/tasks/claim over HTTP updates last_seen_at (end-to-end).
 *
 * Throwaway — delete once the studio UI lands in Phase 5 and covers the
 * same ground via real user flows.
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-1.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import {
  registerWorker,
  revokeWorker,
  touchWorkerHeartbeat,
  countActiveWorkers,
} from "../lib/worker-tokens";
import {
  createRequest,
  claimRequest,
  resetStaleRequests,
} from "../lib/task-queue";

const TEST_WORKER_ID = "verify-phase-1-worker";
const TEST_WORKER_NAME = "Phase 1 Verification";
const API_BASE = process.env.TASK_API_URL ?? "http://localhost:3737";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function main() {
  const db = getDb();

  // Clean any leftover state from a prior run.
  await revokeWorker(TEST_WORKER_ID).catch(() => {});
  await db.execute(sql`DELETE FROM request WHERE description LIKE 'verify-phase-1:%'`);

  // --- 1. touchWorkerHeartbeat ---------------------------------------------
  console.log("[1] touchWorkerHeartbeat");
  const secret = await registerWorker({ id: TEST_WORKER_ID, name: TEST_WORKER_NAME });

  const beforeRow = await db
    .select()
    .from(schema.workers)
    .where(sql`id = ${TEST_WORKER_ID}`);
  assert(beforeRow[0]!.lastSeenAt === null, "fresh worker has last_seen_at = null");

  await touchWorkerHeartbeat(TEST_WORKER_ID);

  const afterRow = await db
    .select()
    .from(schema.workers)
    .where(sql`id = ${TEST_WORKER_ID}`);
  assert(afterRow[0]!.lastSeenAt !== null, "touchWorkerHeartbeat sets last_seen_at");
  const heartbeatAgeMs = Date.now() - afterRow[0]!.lastSeenAt!.getTime();
  assert(heartbeatAgeMs < 5_000, `last_seen_at is recent (${heartbeatAgeMs}ms ago)`);

  // --- 2. countActiveWorkers ----------------------------------------------
  console.log("[2] countActiveWorkers");
  const freshCount = await countActiveWorkers();
  assert(freshCount >= 1, `freshly-pinged worker is counted (got ${freshCount})`);

  // Push last_seen_at outside the 30s window and re-check.
  await db
    .update(schema.workers)
    .set({ lastSeenAt: new Date(Date.now() - 60_000) })
    .where(sql`id = ${TEST_WORKER_ID}`);
  const staleCount = await countActiveWorkers();
  const freshCountAgain = freshCount;
  assert(
    staleCount === freshCountAgain - 1,
    `60s-old worker drops out of count (before=${freshCountAgain}, after=${staleCount})`,
  );

  // --- 3. claimRequest sets stale_at --------------------------------------
  console.log("[3] claimRequest sets stale_at");
  // claimRequest picks the oldest pending row. Other pending rows in the
  // dev DB would cut in front of ours, so drain them first, pinning each
  // non-ours claim in 'planning' (releasing would let them be re-claimed
  // forever, starving our row). Release them at the end.
  const req = await createRequest("human", "verify-phase-1: claimed");
  const holdPinned: string[] = [];
  type ClaimedRequest = { id: string; stale_at: Date | null; status: string };
  let claimedMine: ClaimedRequest | null = null;
  for (let i = 0; i < 50; i++) {
    const row = await claimRequest(TEST_WORKER_ID);
    if (!row) break;
    if (row.id === req.id) {
      claimedMine = row as ClaimedRequest;
      break;
    }
    holdPinned.push(row.id);
  }
  // Return the cut-in-line rows to 'pending' regardless of test outcome.
  for (const id of holdPinned) {
    await db.execute(sql`
      UPDATE request SET status = 'pending', claimed_by = NULL, stale_at = NULL
      WHERE id = ${id}
    `);
  }
  assert(claimedMine !== null, "claimed the row we just created");
  assert(claimedMine!.status === "planning", "status → 'planning'");
  assert(claimedMine!.stale_at !== null, "stale_at is set");
  const staleAtMs = new Date(claimedMine!.stale_at!).getTime();
  const expectedMs = Date.now() + 10 * 60 * 1000;
  assert(
    Math.abs(staleAtMs - expectedMs) < 10_000,
    `stale_at ~10 minutes from now (drift ${staleAtMs - expectedMs}ms)`,
  );

  // --- 4. resetStaleRequests ----------------------------------------------
  console.log("[4] resetStaleRequests");
  // Force this claim stale by setting stale_at into the past.
  await db.execute(sql`
    UPDATE request SET stale_at = now() - interval '1 minute'
    WHERE id = ${req.id}
  `);
  const released = await resetStaleRequests();
  assert(released >= 1, `released at least one row (got ${released})`);

  const [afterReset] = await db
    .select()
    .from(schema.requests)
    .where(sql`id = ${req.id}`);
  assert(afterReset!.status === "pending", "status reset to 'pending'");
  assert(afterReset!.claimedBy === null, "claimed_by cleared");
  assert(afterReset!.staleAt === null, "stale_at cleared");

  // --- 5. Heartbeat via HTTP ----------------------------------------------
  console.log("[5] HTTP /api/tasks/claim updates last_seen_at");
  // Force last_seen_at stale so we can verify the update path lights it up.
  await db
    .update(schema.workers)
    .set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) })
    .where(sql`id = ${TEST_WORKER_ID}`);

  const res = await fetch(`${API_BASE}/api/tasks/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_WORKER_ID}:${secret}`,
    },
    body: "{}",
  });
  assert(
    res.status === 200 || res.status === 204,
    `/api/tasks/claim returned 2xx (got ${res.status})`,
  );

  const [postHttp] = await db
    .select()
    .from(schema.workers)
    .where(sql`id = ${TEST_WORKER_ID}`);
  const httpHeartbeatAgeMs = Date.now() - postHttp!.lastSeenAt!.getTime();
  assert(
    httpHeartbeatAgeMs < 5_000,
    `last_seen_at refreshed by HTTP call (${httpHeartbeatAgeMs}ms ago)`,
  );

  // --- cleanup ------------------------------------------------------------
  await revokeWorker(TEST_WORKER_ID);
  await db.execute(sql`DELETE FROM request WHERE id = ${req.id}`);

  console.log("\nPhase 1 OK.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
