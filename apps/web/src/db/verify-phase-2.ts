/**
 * Phase 2 verification — capability model.
 *
 * Exercises:
 *   1. Schema round-trip: task.capabilities / agent.allowed_capabilities
 *      survive insert + select (array fidelity).
 *   2. createTask rejects a capability that isn't in the agent's ceiling.
 *   3. createTask accepts a valid subset.
 *   4. The HTTP claim endpoint returns the task's capabilities field.
 *   5. createAgentContext wraps a task with requireCapability semantics.
 *
 * Throwaway — delete once the studio UI lands in Phase 5.
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-2.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import {
  registerWorker,
  revokeWorker,
} from "../lib/worker-tokens";
import {
  createRequest,
  createTask,
  CapabilityNotPermittedError,
} from "../lib/task-queue";
import {
  createAgentContext,
  MissingCapabilityError,
} from "../../../agent-worker/src/agent-context";

const TEST_WORKER_ID = "verify-phase-2-worker";
const TEST_AGENT_ID = "verify-phase-2-agent";
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
  await db.execute(sql`DELETE FROM task WHERE description LIKE 'verify-phase-2:%'`);
  await db.execute(sql`DELETE FROM request WHERE description LIKE 'verify-phase-2:%'`);
  await revokeWorker(TEST_WORKER_ID).catch(() => {});
  await db.execute(sql`DELETE FROM agent WHERE id = ${TEST_AGENT_ID}`);

  // Seed a throwaway agent with a specific capability ceiling.
  await db.insert(schema.agents).values({
    id: TEST_AGENT_ID,
    name: "Phase 2 Verification Agent",
    description: "Used only by verify-phase-2.ts",
    icon: "test-tube",
    category: "test",
    type: "first-party",
    allowedCapabilities: ["kafka:read", "s3:read", "trino:query"],
  });

  const secret = await registerWorker({
    id: TEST_WORKER_ID,
    name: "Phase 2 Verification Worker",
  });

  // --- 1. Schema round-trip -----------------------------------------------
  console.log("[1] schema round-trip for text[] columns");
  const [agentRow] = await db
    .select({ allowed: schema.agents.allowedCapabilities })
    .from(schema.agents)
    .where(sql`id = ${TEST_AGENT_ID}`);
  assert(
    Array.isArray(agentRow!.allowed) && agentRow!.allowed.length === 3,
    `agent.allowed_capabilities has 3 entries (${JSON.stringify(agentRow!.allowed)})`,
  );
  assert(
    agentRow!.allowed.includes("kafka:read"),
    "agent.allowed_capabilities preserves 'kafka:read'",
  );

  // --- 2. createTask rejects over-broad capability ------------------------
  console.log("[2] createTask rejects capabilities outside the agent's ceiling");
  const req = await createRequest("human", "verify-phase-2: parent request");
  let caught: unknown = null;
  try {
    await createTask(
      req.id,
      TEST_AGENT_ID,
      "verify-phase-2: should fail",
      "should never create",
      "pending",
      ["kafka:read", "kafka:write"], // kafka:write NOT in ceiling
    );
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof CapabilityNotPermittedError,
    "threw CapabilityNotPermittedError for over-broad capability",
  );
  assert(
    (caught as CapabilityNotPermittedError).offending.includes("kafka:write"),
    "error names the offending capability",
  );

  // --- 3. createTask accepts a valid subset -------------------------------
  console.log("[3] createTask accepts a valid subset");
  const task = await createTask(
    req.id,
    TEST_AGENT_ID,
    "verify-phase-2: valid task",
    "must complete",
    "pending",
    ["kafka:read", "s3:read"],
  );
  assert(task !== undefined, "createTask returned a row");
  assert(
    Array.isArray(task!.capabilities) && task!.capabilities.length === 2,
    `task.capabilities has 2 entries (${JSON.stringify(task!.capabilities)})`,
  );
  assert(
    task!.capabilities.includes("kafka:read") && task!.capabilities.includes("s3:read"),
    "task.capabilities contains the requested grants",
  );

  // --- 4. Claim via HTTP returns capabilities -----------------------------
  console.log("[4] HTTP /api/tasks/claim returns task.capabilities");
  const res = await fetch(`${API_BASE}/api/tasks/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_WORKER_ID}:${secret}`,
    },
    body: JSON.stringify({ agentId: TEST_AGENT_ID }),
  });
  assert(res.status === 200, `claim returned 200 (got ${res.status})`);
  const body = (await res.json()) as { id: string; capabilities: string[] };
  assert(body.id === task!.id, "claimed the task we just created");
  assert(
    Array.isArray(body.capabilities) && body.capabilities.length === 2,
    `claim response includes capabilities array (got ${JSON.stringify(body.capabilities)})`,
  );

  // --- 5. createAgentContext / requireCapability --------------------------
  console.log("[5] createAgentContext + requireCapability");
  const ctx = createAgentContext({
    id: body.id,
    agent_id: TEST_AGENT_ID,
    capabilities: body.capabilities,
    // Other Task fields not needed here.
    request_id: req.id,
    description: "",
    done_criteria: "",
    status: "claimed",
    claimed_by: TEST_WORKER_ID,
    result: null,
    error: null,
    created_at: "",
    claimed_at: null,
    stale_at: null,
    completed_at: null,
  });
  ctx.requireCapability("kafka:read"); // should not throw
  console.log("  ok: requireCapability('kafka:read') passes");

  let missing: unknown = null;
  try {
    ctx.requireCapability("s3:write");
  } catch (err) {
    missing = err;
  }
  assert(
    missing instanceof MissingCapabilityError,
    "requireCapability('s3:write') throws MissingCapabilityError",
  );
  assert(
    (missing as MissingCapabilityError).required === "s3:write",
    "error identifies the missing capability",
  );

  // --- cleanup ------------------------------------------------------------
  await db.execute(sql`DELETE FROM task WHERE id = ${task!.id}`);
  await db.execute(sql`DELETE FROM request WHERE id = ${req.id}`);
  await revokeWorker(TEST_WORKER_ID);
  await db.execute(sql`DELETE FROM agent WHERE id = ${TEST_AGENT_ID}`);

  console.log("\nPhase 2 OK.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
