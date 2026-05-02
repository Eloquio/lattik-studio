/**
 * Phase C verification — end-to-end planner + executor loop.
 *
 * Inserts a request that maps to the test-only `verify-c-noop` skill,
 * then polls the DB for:
 *   1. The planner claims the request and emits at least one task.
 *   2. The request status moves to `approved` (verify-c-noop is auto_approve).
 *   3. The executor claims the task and runs the skill.
 *   4. The task moves to `done` and the request moves to `done`.
 *
 * Requires:
 *   - postgres + web dev server reachable at TASK_API_URL (default localhost:3737)
 *   - agent-worker running (pnpm --filter agent-worker dev)
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-c.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import { createRequest } from "../lib/run-queue";

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 90_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.error(`FAIL: timed out after ${TIMEOUT_MS}ms waiting for ${label}`);
  console.error(`  last value: ${JSON.stringify(last)}`);
  process.exit(1);
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.execute(
    sql`DELETE FROM task WHERE description LIKE 'verify-c:%' OR done_criteria LIKE 'verify-c:%'`,
  );
  await db.execute(
    sql`DELETE FROM request WHERE description LIKE 'verify-c:%'`,
  );
}

async function main(): Promise<void> {
  console.log("[0] cleanup");
  await cleanup();

  console.log("[1] insert pending request that maps to verify-c-noop");
  const req = await createRequest(
    "human",
    "verify-c: run the verify-c-noop skill end-to-end. Use the verify-c-noop skill.",
    { hint: "verify-c-noop" },
  );
  console.log(`  inserted request ${req.id}`);

  const db = getDb();

  console.log("[2] wait for planner to plan the request");
  const planned = await pollUntil(
    async () => {
      const [row] = await db
        .select()
        .from(schema.requests)
        .where(sql`id = ${req.id}`);
      return row ?? null;
    },
    (row) => row.status === "approved" || row.status === "failed",
    "request to be planned",
  );
  assert(
    planned.status === "approved",
    `request status moved to 'approved' (got ${planned.status})`,
  );

  const tasks = await db
    .select()
    .from(schema.runs)
    .where(sql`request_id = ${req.id}`);
  assert(tasks.length > 0, `planner emitted at least one task (got ${tasks.length})`);
  const taskSkillIds = Array.from(new Set(tasks.map((t) => t.skillId)));
  assert(
    taskSkillIds.includes("verify-c-noop"),
    `planner picked verify-c-noop (got ${taskSkillIds.join(", ")})`,
  );

  console.log("[3] wait for executor to complete every task");
  await pollUntil(
    async () => {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(sql`request_id = ${req.id}`);
      return rows;
    },
    (rows) => rows.every((r) => r.status === "done" || r.status === "failed"),
    "all tasks to terminate",
  );

  const finalTasks = await db
    .select()
    .from(schema.runs)
    .where(sql`request_id = ${req.id}`);
  for (const t of finalTasks) {
    assert(
      t.status === "done",
      `task ${t.id} (${t.skillId}) reached 'done' (got ${t.status}${t.error ? `: ${t.error}` : ""})`,
    );
  }

  console.log("[4] wait for request to roll up to 'done'");
  const done = await pollUntil(
    async () => {
      const [row] = await db
        .select()
        .from(schema.requests)
        .where(sql`id = ${req.id}`);
      return row ?? null;
    },
    (row) => row.status === "done" || row.status === "failed",
    "request rollup",
  );
  assert(done.status === "done", `request rolled up to 'done' (got ${done.status})`);

  console.log("\n[cleanup]");
  await cleanup();

  console.log("\nPhase C OK.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
