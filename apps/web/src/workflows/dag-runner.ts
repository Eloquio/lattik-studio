import { sleep } from "workflow";
import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import {
  topoSort,
  effectiveTaskConfig,
  parseDurationMs,
} from "@/lib/dag-topology";
import { parseBranch, type Branch } from "@/lib/dag-blob";
import type { DagDef } from "@/schemas/dag";
import type { TaskRunContext } from "@/schemas/runtime";
import {
  callbackUrl,
  finalizeMissingCallback,
  finalizeTaskSandbox,
  launchTaskSandbox,
  recordAttempt,
} from "./dag-task-steps";
import {
  sandboxDoneHook,
  sandboxDoneToken,
  type SandboxDoneEvent,
} from "./dag-runner-hooks";

// ---------- Types ----------

type TerminalStatus = "succeeded" | "failed" | "skipped";
type TaskOutcome = { ok: true } | { ok: false; error: string };
type DagTask = DagDef["tasks"][number];
type DurationStr = `${number}${"ms" | "s" | "m" | "h" | "d"}`;
type TaskHook = ReturnType<typeof sandboxDoneHook.create>;

export interface DagRunInput {
  dagRunId: string;
  dagId: string;
  branch: Branch;
  /** SHA of the bundle this run is pinned to. Stamped by the dispatcher. */
  bundleSha: string;
  /** ISO 8601, e.g. "2026-05-10T00:00:00.000Z". */
  logicalDatetime: string;
}

interface DagRunContext {
  parsed: DagDef;
  /**
   * Per-workflow-execution UUID. Mixed into the sandbox-done hook token so
   * a re-spawned dagRunner for the same dagRunId never contends with the
   * previous instance's hooks. Generated inside a step, so replay returns
   * the cached value but a fresh workflow execution gets a new one.
   */
  instanceId: string;
}

interface RunOneTaskArgs {
  input: DagRunInput;
  ctx: DagRunContext;
  taskId: string;
  fnName: string;
  timeout: string;
  hook: TaskHook;
}

interface RunTaskWithDepsArgs {
  input: DagRunInput;
  ctx: DagRunContext;
  task: DagTask;
  taskFutures: Map<string, Promise<TerminalStatus>>;
  priorStatuses: Record<string, TerminalStatus>;
  hooks: Map<string, TaskHook>;
}

// Single attempt per task — retries are not wired. Kept as a column on
// task_attempts so adding retries later doesn't churn the schema.
const ONLY_ATTEMPT = 1;

// Workflow watchdog = task timeout + these two graces. Shutdown grace gives
// the sandbox time to die after hitting its own internal timeout; flush
// grace gives its terminal POST time to land. Without both, the workflow
// can race the sandbox and miss the real outcome.
const SANDBOX_SHUTDOWN_GRACE_MS = 30_000;
const CALLBACK_FLUSH_MS = 30_000;
const WATCHDOG_FIRED = Symbol("watchdog");

/**
 * One workflow per scheduled DAG run. Orchestrates tasks in-band (no
 * child workflows), racing each `sandboxDoneHook` against a watchdog.
 * Independent branches run concurrently via `Promise.all` over per-task
 * futures; downstream tasks short-circuit to `skipped` when any direct
 * upstream fails.
 *
 * One hook per task created at workflow scope, right after
 * `priorStatuses`. Each task launches exactly one sandbox so one
 * one-shot hook per task suffices. All hooks are disposed in `finally`
 * regardless of whether they fired.
 */
export async function dagRunner(input: DagRunInput) {
  "use workflow";

  let overall: "succeeded" | "failed" = "failed";
  const failed: string[] = [];
  let hooks: Map<string, TaskHook> | undefined;

  try {
    const ctx = await buildDagRunContext(input);
    const tasks = topoSort(ctx.parsed.tasks);
    const priorStatuses = await loadExistingTerminalStatuses(input.dagRunId);

    hooks = new Map<string, TaskHook>();
    for (const task of tasks) {
      const token = sandboxDoneToken(
        input.dagRunId,
        task.id,
        ctx.instanceId
      );
      hooks.set(task.id, sandboxDoneHook.create({ token }));
    }

    const taskFutures = new Map<string, Promise<TerminalStatus>>();
    for (const task of tasks) {
      taskFutures.set(
        task.id,
        runTaskWithDeps({
          input,
          ctx,
          task,
          taskFutures,
          priorStatuses,
          hooks,
        })
      );
    }

    await Promise.all(taskFutures.values());

    for (const t of tasks) {
      const status = await taskFutures.get(t.id)!;
      if (status === "failed") failed.push(t.id);
    }
    overall = failed.length > 0 ? "failed" : "succeeded";
  } catch (err) {
    // Failure before tasks could be scheduled (buildDagRunContext threw,
    // topoSort threw). Force overall to terminal so the dag_runs row
    // doesn't strand in 'running'. failed[] stays empty — no per-task
    // records to point at.
    overall = "failed";
    console.error(
      `[dagRunner] initialization error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
    );
  } finally {
    if (hooks) {
      for (const h of hooks.values()) h.dispose();
    }
  }

  // Idempotent: returns false if the row was already terminal (a re-spawn
  // saw a previous instance's verdict).
  await markRunTerminal(input.dagRunId, overall);

  return { status: overall, failedTasks: failed };
}

// ---------- Steps ----------

/**
 * Workflow startup step. Reads the DAG definition for `input.dagId` and
 * mints a per-execution `instanceId`. As a step, the result is memoized
 * on workflow replay; a re-spawned execution re-runs it and gets a fresh
 * `instanceId`.
 */
async function buildDagRunContext(input: DagRunInput): Promise<DagRunContext> {
  "use step";
  const [dag] = await getDb()
    .select()
    .from(schema.dags)
    .where(eq(schema.dags.id, input.dagId));
  if (!dag) throw new Error(`dag ${input.dagId} not found`);
  const parsed = dag.parsed as DagDef;

  // Generated inside the step so replay returns the cached UUID. See
  // `DagRunContext.instanceId` for why a re-spawn needs a fresh one.
  const instanceId = randomUUID();

  return { parsed, instanceId };
}

/**
 * Read existing terminal task statuses for this dagRun. Used so a partial
 * clear (some attempts deleted, others kept) can re-run dagRunner and
 * have it skip tasks whose attempts survived. Without this, every re-spawn
 * of dagRunner would re-execute every task.
 */
async function loadExistingTerminalStatuses(
  dagRunId: string
): Promise<Record<string, TerminalStatus>> {
  "use step";
  const rows = await getDb()
    .select()
    .from(schema.taskAttempts)
    .where(eq(schema.taskAttempts.dagRunId, dagRunId));

  const out: Record<string, TerminalStatus> = {};
  const maxAttempt = new Map<string, number>();
  for (const r of rows) {
    if (
      r.status !== "succeeded" &&
      r.status !== "failed" &&
      r.status !== "skipped"
    ) {
      continue;
    }
    const prev = maxAttempt.get(r.taskId) ?? -1;
    if (r.attempt > prev) {
      maxAttempt.set(r.taskId, r.attempt);
      out[r.taskId] = r.status as TerminalStatus;
    }
  }
  return out;
}

async function markSkipped(dagRunId: string, taskId: string) {
  "use step";
  await getDb()
    .insert(schema.taskAttempts)
    .values({
      dagRunId,
      taskId,
      attempt: ONLY_ATTEMPT,
      status: "skipped",
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.taskAttempts.dagRunId,
        schema.taskAttempts.taskId,
        schema.taskAttempts.attempt,
      ],
      set: { status: "skipped", finishedAt: new Date() },
    });
}

async function recordWorkflowError(
  dagRunId: string,
  taskId: string,
  message: string
) {
  "use step";
  const errorMessage = `workflow error: ${message.slice(0, 2000)}`;
  await getDb()
    .insert(schema.taskAttempts)
    .values({
      dagRunId,
      taskId,
      attempt: ONLY_ATTEMPT,
      status: "failed",
      startedAt: new Date(),
      finishedAt: new Date(),
      errorMessage,
    })
    .onConflictDoUpdate({
      target: [
        schema.taskAttempts.dagRunId,
        schema.taskAttempts.taskId,
        schema.taskAttempts.attempt,
      ],
      set: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage,
      },
    });
}

/**
 * Idempotent terminal transition. Only updates rows that aren't already
 * terminal — re-spawned workflows or replays therefore see `false` and
 * skip duplicate side effects.
 */
async function markRunTerminal(
  dagRunId: string,
  status: "succeeded" | "failed"
): Promise<boolean> {
  "use step";
  const updated = await getDb()
    .update(schema.dagRuns)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.dagRuns.id, dagRunId),
        notInArray(schema.dagRuns.status, [
          "succeeded",
          "failed",
          "cancelled",
        ])
      )
    )
    .returning({ id: schema.dagRuns.id });
  return updated.length > 0;
}

// ---------- Helpers ----------

async function runTaskWithDeps({
  input,
  ctx,
  task,
  taskFutures,
  priorStatuses,
  hooks,
}: RunTaskWithDepsArgs): Promise<TerminalStatus> {
  const deps = task.dependsOn ?? [];
  try {
    const depResults = await Promise.all(
      deps.map((d) => taskFutures.get(d)!)
    );

    const prior = priorStatuses[task.id];

    // succeeded/failed are earned outcomes — honor them.
    if (prior === "succeeded" || prior === "failed") return prior;

    // skipped is derived from upstream state: re-run on clean upstream,
    // re-skip otherwise. Handles the partial-clear case where an upstream
    // failure was cleared without also clearing downstream skips.
    if (depResults.some((r) => r === "failed" || r === "skipped")) {
      await markSkipped(input.dagRunId, task.id);
      return "skipped";
    }

    const cfg = effectiveTaskConfig(ctx.parsed, task);
    return await runOneTask({
      input,
      ctx,
      taskId: task.id,
      fnName: task.fn,
      timeout: cfg.timeout,
      hook: hooks.get(task.id)!,
    });
  } catch (err) {
    // Unexpected throw inside runOneTask or its deps. Convert to failed
    // so the workflow finishes cleanly and terminal bookkeeping still
    // runs.
    const msg = err instanceof Error ? err.message : String(err);
    await recordWorkflowError(input.dagRunId, task.id, msg);
    return "failed";
  }
}

/**
 * Per-task orchestration: hook-vs-watchdog race, outcome translation. A
 * plain async helper invoked from within `dagRunner` (`"use workflow"`).
 * The hook is created at workflow scope before any sandbox launches, so a
 * fast-completing sandbox's POST cannot no-op.
 */
async function runOneTask({
  input,
  ctx,
  taskId,
  fnName,
  timeout,
  hook,
}: RunOneTaskArgs): Promise<"succeeded" | "failed"> {
  const timeoutMs = parseDurationMs(timeout);
  const watchdogMs = timeoutMs + SANDBOX_SHUTDOWN_GRACE_MS + CALLBACK_FLUSH_MS;
  const watchdogStr = `${Math.ceil(watchdogMs / 1000)}s` as DurationStr;
  const url = callbackUrl();
  const token = sandboxDoneToken(input.dagRunId, taskId, ctx.instanceId);
  const finalizeCtx = {
    dagRunId: input.dagRunId,
    taskId,
    attempt: ONLY_ATTEMPT,
  };

  const attemptCtx: TaskRunContext = {
    dagId: input.dagId,
    branch: input.branch,
    ...parseBranch(input.branch),
    dagRunId: input.dagRunId,
    taskId,
    logicalDatetime: input.logicalDatetime,
    bundleSha: input.bundleSha,
    attempt: ONLY_ATTEMPT,
  };

  await recordAttempt(input.dagRunId, taskId, ONLY_ATTEMPT, "running");

  let outcome: TaskOutcome;

  const launched = await launchTaskSandbox({
    bundleBranch: input.branch,
    fnName,
    attemptCtx,
    timeoutMs,
    callbackUrl: url,
    callbackToken: token,
  });

  if (!launched.ok) {
    outcome = { ok: false, error: launched.error };
  } else {
    const winner = await Promise.race([
      hook,
      sleep(watchdogStr).then(() => WATCHDOG_FIRED),
    ]);

    if (winner !== WATCHDOG_FIRED) {
      await finalizeTaskSandbox(
        finalizeCtx,
        launched.sandboxId,
        launched.cmdId
      );
      outcome = outcomeFromSandboxEvent(winner as SandboxDoneEvent);
    } else {
      const status = await finalizeMissingCallback(
        finalizeCtx,
        launched.sandboxId,
        launched.cmdId
      );
      outcome = outcomeFromMissingCallback(status, watchdogStr);
    }
  }

  if (outcome.ok) {
    await recordAttempt(input.dagRunId, taskId, ONLY_ATTEMPT, "succeeded");
    return "succeeded";
  }

  await recordAttempt(
    input.dagRunId,
    taskId,
    ONLY_ATTEMPT,
    "failed",
    outcome.error
  );
  return "failed";
}

function outcomeFromSandboxEvent(ev: SandboxDoneEvent): TaskOutcome {
  if (ev.ok) return { ok: true };
  return {
    ok: false,
    error:
      ev.errorMessage || ev.stderrTail || `runner exit ${ev.exitCode}`,
  };
}

function outcomeFromMissingCallback(
  status: { exitCode: number | null; stderrTail: string },
  watchdogStr: string
): TaskOutcome {
  // Runner exited cleanly but the callback was slow / racey with the
  // watchdog — honor the exit code rather than record a spurious fail.
  if (status.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error:
      status.stderrTail ||
      (status.exitCode !== null
        ? `runner exited ${status.exitCode} without callback`
        : `no callback within ${watchdogStr}`),
  };
}
