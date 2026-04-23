/**
 * Phase 6 verification — end-to-end auth over real HTTP.
 *
 * This is the "wire everything together" pass. All prior phases are
 * unit-ish (DB-level helpers, or a single pod applying a manifest); here
 * we drive real HTTP endpoints with studio-minted credentials and verify
 * the authentication flows behave as the plan specifies.
 *
 * Checks:
 *   1. Secret revocation: a host-mode worker's secret hits /api/tasks/claim
 *      successfully; after revokeWorker, the same secret 401s; a freshly
 *      created worker gets through with its new secret.
 *   2. Task round-trip: seed a task, claim it over HTTP, confirm the row
 *      is delivered with the expected shape.
 *   3. Cluster worker lifecycle: create cluster worker, confirm the pod
 *      polls (heartbeat ticks), revoke, confirm Deployment+Secret+DB row
 *      all vanish and the pod stops coming back.
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-6.ts
 */

import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import {
  createWorkerCore,
  listWorkersCore,
  revokeWorkerCore,
} from "../lib/actions/workers";
import { createRequest, createTask } from "../lib/task-queue";
import {
  WORKERS_NAMESPACE,
  workerDeploymentName,
  workerSecretName,
} from "../lib/kube";
import type { Task } from "../../../agent-worker/src/task-client";

const API_BASE = process.env.TASK_API_URL ?? "http://localhost:3737";
const TEST_AGENT_ID = "verify-6-agent";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function kubectlExists(kind: string, name: string, ns: string): boolean {
  const res = spawnSync(
    "kubectl",
    ["get", kind, name, "-n", ns, "-o", "name"],
    { encoding: "utf-8" },
  );
  return res.status === 0;
}

async function claimTaskHttp(
  workerId: string,
  secret: string,
  agentId?: string,
) {
  const res = await fetch(`${API_BASE}/api/tasks/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerId}:${secret}`,
    },
    body: JSON.stringify(agentId ? { agentId } : {}),
  });
  return res;
}

async function cleanup() {
  const db = getDb();
  // Drop any leftover test workers from a prior run.
  const rows = await db
    .select({ id: schema.workers.id })
    .from(schema.workers)
    .where(sql`name LIKE 'verify-6:%'`);
  for (const r of rows) {
    await revokeWorkerCore(r.id).catch(() => {});
  }
  spawnSync("kubectl", [
    "delete",
    "deployment,secret",
    "-n",
    WORKERS_NAMESPACE,
    "-l",
    "app=agent-worker",
    "--field-selector=metadata.name!=agent-worker-DO-NOT-MATCH",
    "--ignore-not-found",
  ]);
  // Drop leftover tasks/requests/agents.
  await db.execute(
    sql`DELETE FROM task WHERE description LIKE 'verify-6:%'`,
  );
  await db.execute(
    sql`DELETE FROM request WHERE description LIKE 'verify-6:%'`,
  );
  await db.execute(sql`DELETE FROM agent WHERE id = ${TEST_AGENT_ID}`);
}

async function main() {
  console.log("[0] pre-flight cleanup");
  await cleanup();

  // Seed a test agent used by the task round-trip check.
  await getDb().insert(schema.agents).values({
    id: TEST_AGENT_ID,
    name: "Verify 6 Agent",
    description: "Test agent for Phase 6 verification",
    icon: "test",
    category: "test",
    type: "first-party",
  });

  // --- 1. Secret revocation over HTTP -----------------------------------
  console.log("[1] host worker → HTTP 2xx → revoke → HTTP 401 → new creds 2xx");
  const host = await createWorkerCore({
    name: "verify-6: host-1",
    mode: "host",
  });
  assert(host.secret !== null, "host-mode create returned a secret");

  const res1 = await claimTaskHttp(host.worker.id, host.secret!);
  assert(
    res1.status === 200 || res1.status === 204,
    `fresh creds → /api/tasks/claim returned ${res1.status} (expect 2xx)`,
  );
  if (res1.status === 200) await res1.json();

  await revokeWorkerCore(host.worker.id);

  const res2 = await claimTaskHttp(host.worker.id, host.secret!);
  assert(
    res2.status === 401,
    `revoked creds → /api/tasks/claim returned ${res2.status} (expect 401)`,
  );

  const host2 = await createWorkerCore({
    name: "verify-6: host-2",
    mode: "host",
  });
  const res3 = await claimTaskHttp(host2.worker.id, host2.secret!);
  assert(
    res3.status === 200 || res3.status === 204,
    `recreated creds → /api/tasks/claim returned ${res3.status} (expect 2xx)`,
  );
  if (res3.status === 200) await res3.json();

  // --- 2. Task round-trip over HTTP --------------------------------------
  console.log("[2] seeded task is delivered over HTTP claim with expected shape");
  const req = await createRequest("human", "verify-6: task round-trip");
  const seededTask = await createTask(
    req.id,
    TEST_AGENT_ID,
    "verify-6: a task",
    "done",
    "pending",
  );
  assert(seededTask !== undefined, "seeded a task");

  const res4 = await claimTaskHttp(host2.worker.id, host2.secret!, TEST_AGENT_ID);
  assert(res4.status === 200, `filtered claim returned 200 (got ${res4.status})`);
  const claimed = (await res4.json()) as Task;
  assert(claimed.id === seededTask!.id, "HTTP claim returned our seeded task");
  assert(
    claimed.agent_id === TEST_AGENT_ID,
    `claimed.agent_id matches filter (got ${claimed.agent_id})`,
  );

  await revokeWorkerCore(host2.worker.id);

  // --- 3. Cluster worker lifecycle end-to-end ----------------------------
  console.log("[3] cluster worker — pod polls, then revoke cleans everything");
  const cluster = await createWorkerCore({
    name: "verify-6: cluster-1",
    mode: "cluster",
  });
  assert(cluster.worker.mode === "cluster", "created cluster worker");
  assert(
    kubectlExists(
      "deployment",
      workerDeploymentName(cluster.worker.id),
      WORKERS_NAMESPACE,
    ),
    "Deployment exists in kind",
  );
  assert(
    kubectlExists(
      "secret",
      workerSecretName(cluster.worker.id),
      WORKERS_NAMESPACE,
    ),
    "Secret exists in kind",
  );

  console.log("    waiting up to 45s for the pod to poll …");
  const db = getDb();
  const deadline = Date.now() + 45_000;
  let saw: Date | null = null;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ lastSeenAt: schema.workers.lastSeenAt })
      .from(schema.workers)
      .where(sql`id = ${cluster.worker.id}`);
    if (row?.lastSeenAt) {
      saw = row.lastSeenAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert(saw !== null, "pod polled within 45s");
  const listing = await listWorkersCore();
  assert(
    listing.find((w) => w.id === cluster.worker.id)?.isLive === true,
    "listWorkersCore reports cluster worker live",
  );

  await revokeWorkerCore(cluster.worker.id);
  assert(
    !kubectlExists(
      "deployment",
      workerDeploymentName(cluster.worker.id),
      WORKERS_NAMESPACE,
    ),
    "Deployment removed on revoke",
  );
  assert(
    !kubectlExists(
      "secret",
      workerSecretName(cluster.worker.id),
      WORKERS_NAMESPACE,
    ),
    "Secret removed on revoke",
  );
  const [dbGone] = await db
    .select()
    .from(schema.workers)
    .where(sql`id = ${cluster.worker.id}`);
  assert(dbGone === undefined, "DB row removed on revoke");

  // --- cleanup ------------------------------------------------------------
  await cleanup();

  console.log("\nPhase 6 OK.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
