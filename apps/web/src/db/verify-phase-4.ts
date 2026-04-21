/**
 * Phase 4 verification — worker image + manifest.
 *
 * Registers a test worker, writes its credentials as a k8s Secret in the
 * `workers` namespace, applies a minimal Deployment using the prebuilt
 * lattik/agent-worker:dev image, then polls postgres to confirm the pod
 * is polling the claim endpoint (last_seen_at ticks within 30s).
 *
 * Cleans up the Deployment, Secret, and worker row on exit (success or
 * failure).
 *
 * Prereqs: `pnpm worker:image-build` has run, cluster is up, studio is
 * running on localhost:3737. The pod reaches studio via
 * host.docker.internal:3737 (Docker Desktop for Mac).
 *
 * Run: pnpm --filter web tsx src/db/verify-phase-4.ts
 */

import { execSync, spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as schema from "./schema";
import { registerWorker, revokeWorker } from "../lib/worker-tokens";

const TEST_WORKER_ID = "verify-phase-4";
const TEST_WORKER_NAME = "Phase 4 Verification";
const DEPLOYMENT_NAME = `agent-worker-${TEST_WORKER_ID}`;
const SECRET_NAME = `${DEPLOYMENT_NAME}-creds`;
const NAMESPACE = "workers";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok: ${msg}`);
}

function kubectl(args: string[], stdin?: string) {
  const result = spawnSync("kubectl", args, {
    input: stdin,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `kubectl ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function kubectlIgnoreErr(args: string[]) {
  return spawnSync("kubectl", args, { encoding: "utf-8" });
}

async function cleanup() {
  kubectlIgnoreErr([
    "delete",
    "deployment",
    DEPLOYMENT_NAME,
    "-n",
    NAMESPACE,
    "--ignore-not-found",
  ]);
  kubectlIgnoreErr([
    "delete",
    "secret",
    SECRET_NAME,
    "-n",
    NAMESPACE,
    "--ignore-not-found",
  ]);
  await revokeWorker(TEST_WORKER_ID).catch(() => {});
}

async function main() {
  console.log("[0] Pre-flight cleanup");
  await cleanup();

  // 1. Mint credentials via the same path studio will use in Phase 5.
  console.log("[1] Registering test worker in postgres");
  const secret = await registerWorker({
    id: TEST_WORKER_ID,
    name: TEST_WORKER_NAME,
  });
  console.log(`  ok: worker ${TEST_WORKER_ID} registered`);

  // 2. Apply Secret — opaque key/value pair used by envFrom.
  console.log("[2] Applying k8s Secret with credentials");
  kubectl(
    ["apply", "-f", "-"],
    `
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  LATTIK_WORKER_ID: ${TEST_WORKER_ID}
  LATTIK_WORKER_SECRET: ${secret}
`.trim(),
  );
  console.log(`  ok: secret/${SECRET_NAME} applied`);

  // 3. Apply Deployment — pod mounts Secret via envFrom, bakes in
  //    TASK_API_URL pointing at the host.
  console.log("[3] Applying minimal Deployment");
  kubectl(
    ["apply", "-f", "-"],
    `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEPLOYMENT_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: agent-worker
    worker-id: ${TEST_WORKER_ID}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: agent-worker
      worker-id: ${TEST_WORKER_ID}
  template:
    metadata:
      labels:
        app: agent-worker
        worker-id: ${TEST_WORKER_ID}
    spec:
      containers:
        - name: agent-worker
          image: lattik/agent-worker:dev
          imagePullPolicy: Never
          envFrom:
            - secretRef:
                name: ${SECRET_NAME}
          env:
            - name: TASK_API_URL
              value: "http://host.docker.internal:3737"
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"
`.trim(),
  );
  console.log(`  ok: deployment/${DEPLOYMENT_NAME} applied`);

  // 4. Wait for pod readiness (image-pull + node start).
  console.log("[4] Waiting for pod to become Ready");
  kubectl([
    "wait",
    "-n",
    NAMESPACE,
    "--for=condition=available",
    `deployment/${DEPLOYMENT_NAME}`,
    "--timeout=90s",
  ]);
  console.log(`  ok: deployment/${DEPLOYMENT_NAME} available`);

  // 5. Poll DB for a fresh last_seen_at. The worker polls every 5s;
  //    give it up to 30s to tick at least once.
  console.log("[5] Polling postgres for heartbeat");
  const db = getDb();
  const deadline = Date.now() + 30_000;
  let lastSeenAt: Date | null = null;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ lastSeenAt: schema.workers.lastSeenAt })
      .from(schema.workers)
      .where(sql`id = ${TEST_WORKER_ID}`);
    if (row?.lastSeenAt) {
      lastSeenAt = row.lastSeenAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!lastSeenAt) {
    // Dump a little context before failing.
    const logs = execSync(
      `kubectl logs -n ${NAMESPACE} deployment/${DEPLOYMENT_NAME} --tail=50 2>&1 || true`,
    ).toString();
    console.error("Pod logs (last 50 lines):\n" + logs);
  }
  assert(lastSeenAt !== null, "worker.last_seen_at populated within 30s");
  const ageMs = Date.now() - lastSeenAt!.getTime();
  assert(ageMs < 30_000, `last_seen_at is fresh (${ageMs}ms old)`);

  console.log("\nPhase 4 OK.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log("\n[cleanup] tearing down Deployment, Secret, worker row");
    await cleanup();
    process.exit(process.exitCode ?? 0);
  });
