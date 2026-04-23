/**
 * Phase 3 verification — deterministic webhook path.
 *
 * Exercises:
 *   1. applySkillRecipe happy path — inserts tasks at "pending"; the
 *      enclosing transaction marks the request "approved" with skill_id.
 *   2. applySkillRecipe rollback — a skill referencing an unknown agent
 *      aborts the transaction, leaving zero request rows and zero task
 *      rows behind.
 *
 * Uses an in-memory Skill (not loaded from disk) so the verification
 * doesn't depend on real skill files or seeded agents.
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-3.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import { applySkillRecipe, createRequest } from "../lib/task-queue";
import type { Skill } from "../lib/skills";

const ALPHA_AGENT = "verify-3-alpha";
const BETA_AGENT = "verify-3-beta";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const happySkill: Skill = {
  name: "verify-3-happy-skill",
  description: "Phase 3 verification — happy path",
  auto_approve: true,
  args: { target: { type: "string", description: "target id" } },
  tasks: [
    {
      agent: ALPHA_AGENT,
      description: "Step A for {{target}}",
      done_criteria: "A completed for {{target}}",
    },
    {
      agent: BETA_AGENT,
      description: "Step B for {{target}}",
      done_criteria: "B completed for {{target}}",
    },
  ],
};

const unknownAgentSkill: Skill = {
  name: "verify-3-unknown-agent-skill",
  description: "Phase 3 verification — references a nonexistent agent",
  auto_approve: true,
  args: {},
  tasks: [
    {
      agent: "does-not-exist",
      description: "Step",
      done_criteria: "done",
    },
  ],
};

async function countRowsForDescription(prefix: string) {
  const db = getDb();
  const [reqCount] = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM request WHERE description LIKE ${prefix + "%"}`,
  );
  const [taskCount] = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM task WHERE description LIKE ${prefix + "%"}`,
  );
  return {
    requests: parseInt(reqCount?.count ?? "0", 10),
    tasks: parseInt(taskCount?.count ?? "0", 10),
  };
}

async function main() {
  const db = getDb();

  // Clean any leftover state from a prior run.
  await db.execute(sql`DELETE FROM task  WHERE description LIKE 'verify-3:%'`);
  await db.execute(sql`DELETE FROM request WHERE description LIKE 'verify-3:%'`);
  await db.execute(sql`DELETE FROM agent WHERE id IN (${ALPHA_AGENT}, ${BETA_AGENT})`);

  // Seed two test agents (no capability ceiling anymore — just existence).
  await db.insert(schema.agents).values([
    {
      id: ALPHA_AGENT,
      name: "Verify 3 Alpha",
      description: "Test agent alpha",
      icon: "test",
      category: "test",
      type: "first-party",
    },
    {
      id: BETA_AGENT,
      name: "Verify 3 Beta",
      description: "Test agent beta",
      icon: "test",
      category: "test",
      type: "first-party",
    },
  ]);

  // --- 1. Happy path ------------------------------------------------------
  console.log("[1] applySkillRecipe happy path inside a transaction");
  const happyDesc = "verify-3: happy path";
  const happyRequestId = await db.transaction(async (tx) => {
    const request = await createRequest(
      "webhook",
      happyDesc,
      { source: "verify-3" },
      {
        skillId: happySkill.name,
        status: "approved",
        client: tx,
      },
    );
    const tasks = await applySkillRecipe(tx, request.id, happySkill, {
      target: "hello",
    });
    assert(tasks.length === 2, "applySkillRecipe inserted 2 tasks");
    return request.id;
  });

  const [happyRequest] = await db
    .select()
    .from(schema.requests)
    .where(sql`id = ${happyRequestId}`);
  assert(happyRequest!.status === "approved", "request status = 'approved'");
  assert(
    happyRequest!.skillId === happySkill.name,
    "request.skill_id matches the skill",
  );
  assert(happyRequest!.source === "webhook", "request.source = 'webhook'");

  const happyTasks = await db
    .select()
    .from(schema.tasks)
    .where(sql`request_id = ${happyRequestId}`)
    .orderBy(schema.tasks.createdAt);
  assert(happyTasks.length === 2, "2 tasks inserted for the request");
  assert(
    happyTasks.every((t) => t.status === "pending"),
    "both tasks at status 'pending' (no human approval needed)",
  );
  assert(
    happyTasks[0]!.description.includes("hello"),
    "task description interpolation worked",
  );

  // --- 2. Rollback on unknown agent ---------------------------------------
  console.log("[2] unknown agent rolls back the transaction");
  const unknownDesc = "verify-3: unknown-agent";
  let unknownErr: unknown = null;
  try {
    await db.transaction(async (tx) => {
      await createRequest(
        "webhook",
        unknownDesc,
        { source: "verify-3" },
        {
          skillId: unknownAgentSkill.name,
          status: "approved",
          client: tx,
        },
      );
      await applySkillRecipe(tx, "unused", unknownAgentSkill, {});
    });
  } catch (err) {
    unknownErr = err;
  }
  assert(unknownErr !== null, "threw when skill references an unknown agent");
  assert(
    unknownErr instanceof Error &&
      /unknown agent/.test((unknownErr as Error).message),
    `error message mentions unknown agent (got: ${(unknownErr as Error).message})`,
  );

  const unknownCounts = await countRowsForDescription(unknownDesc);
  assert(unknownCounts.requests === 0, "no request row persisted");
  assert(unknownCounts.tasks === 0, "no task rows persisted");

  // --- cleanup ------------------------------------------------------------
  await db.execute(sql`DELETE FROM task  WHERE description LIKE 'verify-3:%'`);
  await db.execute(sql`DELETE FROM request WHERE description LIKE 'verify-3:%'`);
  await db.execute(sql`DELETE FROM agent WHERE id IN (${ALPHA_AGENT}, ${BETA_AGENT})`);

  console.log("\nPhase 3 OK.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
