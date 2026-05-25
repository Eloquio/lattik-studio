import { and, count, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { readBundleSha, type Branch } from "./dag-blob";
import type { DagDef } from "@/schemas/dag";

/**
 * Cap on cron `.next()` iterations per DAG per tick. The unit is
 * iterations, not minutes — a `* * * * *` schedule hits this in 525,600
 * iterations (one year of minutely runs); a `0 0 * * *` schedule in 525,600
 * days. The catchup bound is "until now", but a poorly-configured DAG with
 * a years-old startDate and minutely schedule could otherwise iterate
 * millions of times here.
 */
const ENQUEUE_BOUNDARY_CAP = 60 * 24 * 365;

/**
 * Compute the deterministic dag_runs.id for a (dagRowId, logicalDatetime).
 *
 * Format: `<dagId>__<compactIso>` (e.g. `daily_metrics__20260508T021500000Z`).
 * URL-safe by construction — avoids `:` and `.` which Vercel's edge router
 * normalizes in path segments.
 */
export function computeRunId(
  dagRowId: string,
  logicalDatetime: Date
): string {
  const ts = logicalDatetime.toISOString().replace(/[-:.]/g, "");
  return `${dagRowId}__${ts}`;
}

/**
 * Compute logical datetimes between (lastEnqueued ?? startDate) and now,
 * INSERT one queued `dag_runs` row per missed datetime. Idempotent via
 * UNIQUE (dag_id, branch, logical_datetime).
 *
 * Catchup semantics:
 *   - lastEnqueued set: resume from that bookmark (regardless of catchup).
 *   - catchup=true, no bookmark: start from start_date, enqueue every
 *     boundary up to now.
 *   - catchup=false, no bookmark: enqueue only the most-recent-past
 *     boundary so the DAG fires once on enable, then forward from there.
 */
export async function enqueueMissedRuns(
  dagRow: typeof schema.dags.$inferSelect
) {
  const parsed = dagRow.parsed as DagDef;
  const now = new Date();

  let cursor: Date;
  if (dagRow.lastEnqueuedLogicalDatetime) {
    cursor = new Date(dagRow.lastEnqueuedLogicalDatetime);
  } else if (parsed.catchup) {
    const sd =
      typeof parsed.startDate === "string"
        ? parsed.startDate
        : new Date(parsed.startDate).toISOString();
    cursor = new Date(sd);
  } else {
    // Anchor to just before the most-recent-past boundary so the very
    // next .next() call returns it (and it's <= now).
    const probe = CronExpressionParser.parse(parsed.schedule, {
      currentDate: new Date(now.getTime() + 1),
      tz: parsed.timezone,
    });
    try {
      const mostRecentPast = probe.prev().toDate();
      cursor = new Date(mostRecentPast.getTime() - 1);
    } catch {
      return [];
    }
  }

  const interval = CronExpressionParser.parse(parsed.schedule, {
    currentDate: cursor,
    tz: parsed.timezone,
  });

  const enqueued: { runId: string; logicalDatetime: Date }[] = [];

  for (let i = 0; i < ENQUEUE_BOUNDARY_CAP; i += 1) {
    let next: Date;
    try {
      next = interval.next().toDate();
    } catch {
      break;
    }
    if (next.getTime() > now.getTime()) break;
    enqueued.push({
      runId: computeRunId(dagRow.id, next),
      logicalDatetime: next,
    });
  }

  if (enqueued.length === 0) return [];

  await getDb()
    .insert(schema.dagRuns)
    .values(
      enqueued.map((e) => ({
        id: e.runId,
        dagId: dagRow.id,
        branch: dagRow.branch,
        logicalDatetime: e.logicalDatetime,
        status: "queued" as const,
        triggeredBy: "cron",
        // Pin to the YAML version this run was scheduled against. The
        // launch step recomputes sha256(dags.yamlRaw) and refuses to
        // launch on mismatch — guarantees every task in this run sees
        // the same topology even if a YAML PR merges between enqueue
        // and execution.
        manifestSha: dagRow.yamlHash,
      }))
    )
    .onConflictDoNothing();

  const latest = enqueued[enqueued.length - 1].logicalDatetime;
  await getDb()
    .update(schema.dags)
    .set({ lastEnqueuedLogicalDatetime: latest, updatedAt: new Date() })
    .where(eq(schema.dags.id, dagRow.id));

  return enqueued;
}

/**
 * Dispatch up to (maxActiveRuns - currentlyRunning) queued runs by calling
 * `start(dagRunner, [...], { runId })` on each. The queued→running flip is
 * an atomic check-and-set so overlapping ticks can't double-start a run.
 */
export async function dispatchQueued(
  dagRow: typeof schema.dags.$inferSelect
) {
  // `workflow/api` is server-only and pulls in build-time tooling; defer
  // the import so other consumers of this module (tests, type-only callers)
  // aren't forced through it.
  const { dagRunner } = await import("@/workflows/dag-runner");
  const { start } = await import("workflow/api");

  const [runningRow] = await getDb()
    .select({ n: count() })
    .from(schema.dagRuns)
    .where(
      and(
        eq(schema.dagRuns.dagId, dagRow.id),
        eq(schema.dagRuns.branch, dagRow.branch),
        eq(schema.dagRuns.status, "running")
      )
    );
  const slots = Math.max(0, dagRow.maxActiveRuns - (runningRow?.n ?? 0));
  if (slots === 0) return [];

  const queued = await getDb()
    .select()
    .from(schema.dagRuns)
    .where(
      and(
        eq(schema.dagRuns.dagId, dagRow.id),
        eq(schema.dagRuns.branch, dagRow.branch),
        eq(schema.dagRuns.status, "queued")
      )
    )
    .orderBy(schema.dagRuns.logicalDatetime)
    .limit(slots);

  const dispatched: string[] = [];
  for (const run of queued) {
    // Read bundleSha before the claim so it lands in the same UPDATE
    // that flips status → running. A transient Blob hiccup yields
    // "unknown" rather than stranding the run.
    const bundleSha =
      (await readBundleSha(dagRow.branch as Branch)) ?? "unknown";

    // Atomic claim: only one tick can flip a given row from queued →
    // running. Without this, two overlapping ticks could both pass the
    // SELECT and both call start(dagRunner, …) for the same row, leading
    // to a hook-token collision inside the workflow runtime.
    const claimed = await getDb()
      .update(schema.dagRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        bundleSha,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.dagRuns.id, run.id),
          eq(schema.dagRuns.status, "queued")
        )
      )
      .returning({ id: schema.dagRuns.id });
    if (claimed.length === 0) continue;

    try {
      const child = await start(dagRunner, [
        {
          dagRunId: run.id,
          dagId: dagRow.id,
          branch: dagRow.branch as Branch,
          bundleSha,
          logicalDatetime: run.logicalDatetime.toISOString(),
        },
      ]);
      await getDb()
        .update(schema.dagRuns)
        .set({ workflowRunId: child.runId, updatedAt: new Date() })
        .where(eq(schema.dagRuns.id, run.id));
      dispatched.push(run.id);
    } catch (err) {
      console.error(`[scheduler] failed to start ${run.id}`, err);
      // Roll the row back to queued so a future tick retries instead of
      // leaving an orphan 'running' row with no workflowRunId.
      await getDb()
        .update(schema.dagRuns)
        .set({
          status: "queued",
          startedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.dagRuns.id, run.id));
    }
  }
  return dispatched;
}

/**
 * Detect dag_runs whose backing Workflow run reached a terminal failure
 * state but whose row never got updated, and mirror the failure.
 *
 * Why: dagRunner writes the terminal status in its last step. If the
 * workflow crashes earlier, the row stays 'running' forever and continues
 * to occupy a maxActiveRuns slot.
 *
 * Only `failed`/`cancelled` workflow states are reconciled. `completed` is
 * ambiguous — dagRunner returns successfully even when some tasks failed,
 * so workflow `completed` doesn't tell us the dag-level outcome.
 *
 * 60s grace protects against racing a normally-finishing run.
 */
export async function reconcileOrphanedRuns() {
  const { getRun } = await import("workflow/api");

  const candidates = await getDb()
    .select()
    .from(schema.dagRuns)
    .where(
      and(
        eq(schema.dagRuns.status, "running"),
        isNotNull(schema.dagRuns.workflowRunId),
        lt(schema.dagRuns.updatedAt, new Date(Date.now() - 60_000))
      )
    );

  let reconciled = 0;
  for (const row of candidates) {
    let wfStatus: string;
    try {
      wfStatus = await getRun(row.workflowRunId!).status;
    } catch (err) {
      console.error(
        `[scheduler] getRun(${row.workflowRunId}) failed for ${row.id}`,
        err
      );
      continue;
    }

    if (wfStatus !== "failed" && wfStatus !== "cancelled") continue;

    const note = `[reconciler] workflow ${row.workflowRunId} reached terminal ${wfStatus} without the markRunTerminal step landing`;
    await getDb()
      .update(schema.dagRuns)
      .set({
        status: wfStatus,
        finishedAt: new Date(),
        notes: row.notes ? `${row.notes}\n${note}` : note,
        updatedAt: new Date(),
      })
      .where(eq(schema.dagRuns.id, row.id));

    await getDb()
      .update(schema.taskAttempts)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: `[reconciler] orphaned by workflow ${wfStatus}`,
      })
      .where(
        and(
          eq(schema.taskAttempts.dagRunId, row.id),
          eq(schema.taskAttempts.status, "running")
        )
      );

    reconciled += 1;
  }

  return { reconciled };
}

/**
 * One scheduler tick: reconcile orphans (to free maxActiveRuns slots),
 * then for every enabled, non-archived DAG enqueue missed runs and
 * dispatch.
 */
export async function runSchedulerTick() {
  const enabledDags = await getDb()
    .select()
    .from(schema.dags)
    .where(
      and(eq(schema.dags.enabled, true), isNull(schema.dags.archivedAt))
    );

  let runsReconciled = 0;
  try {
    const r = await reconcileOrphanedRuns();
    runsReconciled = r.reconciled;
  } catch (err) {
    console.error("[scheduler] reconcileOrphanedRuns failed", err);
  }

  let totalEnqueued = 0;
  let totalDispatched = 0;
  for (const dag of enabledDags) {
    const enqueued = await enqueueMissedRuns(dag);
    totalEnqueued += enqueued.length;
    const dispatched = await dispatchQueued(dag);
    totalDispatched += dispatched.length;
  }

  return {
    dagsConsidered: enabledDags.length,
    runsEnqueued: totalEnqueued,
    runsDispatched: totalDispatched,
    runsReconciled,
  };
}
