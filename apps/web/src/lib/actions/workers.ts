"use server";

/**
 * Server actions for worker lifecycle. Studio owns creation, renaming, and
 * revocation of workers — both the DB row and (for cluster-mode workers)
 * the k8s Secret + Deployment that actually run the process.
 *
 * Create flow, cluster mode:
 *   1. Generate UUID + mint secret in a DB transaction.
 *   2. Apply Secret + Deployment via kubectl.
 *   3. On any failure after step (1): best-effort delete the k8s objects
 *      and the DB row, then propagate the error.
 *
 * Create flow, host mode:
 *   1. Generate UUID + mint secret.
 *   2. Return the secret + env block to the client; the dev pastes into
 *      apps/agent-worker/.env and runs pnpm --filter agent-worker dev.
 *   3. No k8s objects involved.
 *
 * See docs/PLAN-worker-deployment-and-capabilities.md for the full model.
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import type { WorkerMode } from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";
import {
  registerWorker,
  revokeWorker as revokeWorkerRow,
  WORKER_LIVENESS_WINDOW_MS,
} from "@/lib/worker-tokens";
import {
  applyManifest,
  buildWorkerManifests,
  deleteResource,
  WORKERS_NAMESPACE,
  workerDeploymentName,
  workerSecretName,
} from "@/lib/kube";

export interface WorkerSummary {
  id: string;
  name: string;
  mode: WorkerMode;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isLive: boolean;
}

export async function listWorkers(): Promise<WorkerSummary[]> {
  await requireUser();
  return listWorkersCore();
}

export async function getWorker(id: string): Promise<WorkerSummary | null> {
  await requireUser();
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.workers.id,
      name: schema.workers.name,
      mode: schema.workers.mode,
      lastSeenAt: schema.workers.lastSeenAt,
      createdAt: schema.workers.createdAt,
      updatedAt: schema.workers.updatedAt,
    })
    .from(schema.workers)
    .where(eq(schema.workers.id, id))
    .limit(1);
  if (!row) return null;
  const livenessThreshold = Date.now() - WORKER_LIVENESS_WINDOW_MS;
  return {
    ...row,
    isLive: row.lastSeenAt ? row.lastSeenAt.getTime() > livenessThreshold : false,
  };
}

/**
 * Auth-less version of listWorkers for verification scripts. Callers that
 * should never reach a user (cron, tests, bootstrap scripts) use this.
 */
export async function listWorkersCore(): Promise<WorkerSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.workers.id,
      name: schema.workers.name,
      mode: schema.workers.mode,
      lastSeenAt: schema.workers.lastSeenAt,
      createdAt: schema.workers.createdAt,
      updatedAt: schema.workers.updatedAt,
    })
    .from(schema.workers)
    .orderBy(desc(schema.workers.createdAt));
  const livenessThreshold = Date.now() - WORKER_LIVENESS_WINDOW_MS;
  return rows.map((r) => ({
    ...r,
    isLive: r.lastSeenAt ? r.lastSeenAt.getTime() > livenessThreshold : false,
  }));
}

const createWorkerSchema = z.object({
  name: z.string().min(1).max(120),
  mode: z.enum(["cluster", "host"]),
});

/**
 * Result of createWorker. `secret` is only populated when mode = "host" —
 * for cluster mode, the secret is written straight into a k8s Secret and
 * is never shown to the user. In both cases `envBlock` is returned (it's
 * useful context even for cluster workers, e.g. if a dev wants to tail
 * logs locally).
 */
export interface CreateWorkerResult {
  worker: WorkerSummary;
  /** Only non-null for mode="host". Shown to the user once. */
  secret: string | null;
  envBlock: string;
}

export async function createWorker(input: {
  name: string;
  mode: WorkerMode;
}): Promise<CreateWorkerResult> {
  await requireUser();
  return createWorkerCore(input);
}

/** Auth-less core for createWorker — see listWorkersCore's docstring. */
export async function createWorkerCore(input: {
  name: string;
  mode: WorkerMode;
}): Promise<CreateWorkerResult> {
  const { name, mode } = createWorkerSchema.parse(input);

  const id = crypto.randomUUID();
  const secret = await registerWorker({ id, name, mode });

  if (mode === "host") {
    const envBlock = buildEnvBlock(id, secret);
    return {
      worker: await getWorkerSummary(id),
      secret,
      envBlock,
    };
  }

  // cluster mode — apply k8s objects, rolling back on any failure.
  try {
    const manifest = buildWorkerManifests({ workerId: id, name, secret });
    await applyManifest(manifest);
  } catch (err) {
    // Best-effort cleanup. Failures here surface as orphan k8s objects or
    // a stranded DB row; the user can Revoke them from the UI to recover.
    await Promise.allSettled([
      deleteResource(
        "deployment",
        workerDeploymentName(id),
        WORKERS_NAMESPACE,
      ),
      deleteResource("secret", workerSecretName(id), WORKERS_NAMESPACE),
      revokeWorkerRow(id),
    ]);
    throw err;
  }

  return {
    worker: await getWorkerSummary(id),
    secret: null,
    envBlock: buildEnvBlock(id, secret),
  };
}

const renameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
});

export async function renameWorker(input: {
  id: string;
  name: string;
}): Promise<WorkerSummary> {
  await requireUser();
  return renameWorkerCore(input);
}

/** Auth-less core for renameWorker. */
export async function renameWorkerCore(input: {
  id: string;
  name: string;
}): Promise<WorkerSummary> {
  const { id, name } = renameSchema.parse(input);
  const db = getDb();
  const [row] = await db
    .update(schema.workers)
    .set({ name, updatedAt: new Date() })
    .where(eq(schema.workers.id, id))
    .returning({ id: schema.workers.id });
  if (!row) {
    throw new Error(`Unknown worker: ${id}`);
  }
  return getWorkerSummary(id);
}

export async function revokeWorker(id: string): Promise<void> {
  await requireUser();
  return revokeWorkerCore(id);
}

/** Auth-less core for revokeWorker. */
export async function revokeWorkerCore(id: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ mode: schema.workers.mode })
    .from(schema.workers)
    .where(eq(schema.workers.id, id))
    .limit(1);
  if (!row) return; // idempotent

  if (row.mode === "cluster") {
    // Delete k8s objects first; if kubectl fails, bail before touching the
    // DB so the user can retry from the same UI state.
    await deleteResource(
      "deployment",
      workerDeploymentName(id),
      WORKERS_NAMESPACE,
    );
    await deleteResource("secret", workerSecretName(id), WORKERS_NAMESPACE);
  }

  await revokeWorkerRow(id);
}

async function getWorkerSummary(id: string): Promise<WorkerSummary> {
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.workers.id,
      name: schema.workers.name,
      mode: schema.workers.mode,
      lastSeenAt: schema.workers.lastSeenAt,
      createdAt: schema.workers.createdAt,
      updatedAt: schema.workers.updatedAt,
    })
    .from(schema.workers)
    .where(eq(schema.workers.id, id))
    .limit(1);
  if (!row) throw new Error(`Worker disappeared: ${id}`);
  const livenessThreshold = Date.now() - WORKER_LIVENESS_WINDOW_MS;
  return {
    ...row,
    isLive: row.lastSeenAt
      ? row.lastSeenAt.getTime() > livenessThreshold
      : false,
  };
}

function buildEnvBlock(workerId: string, secret: string): string {
  return [
    `TASK_API_URL=http://localhost:3737`,
    `LATTIK_WORKER_ID=${workerId}`,
    `LATTIK_WORKER_SECRET=${secret}`,
  ].join("\n");
}
