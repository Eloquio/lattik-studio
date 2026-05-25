import { Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { RUNNER_TEMPLATE } from "./dag-runner.template.generated";
import {
  fetchBlobBytes,
  blobPaths,
  putBlobText,
  type Branch,
} from "@/lib/dag-blob";
import { deriveTokenKey } from "@/lib/sandbox-callback";
import { verifyManifestSha } from "@/lib/manifest-verifier";
import type { TaskRunContext } from "@/schemas/runtime";

export interface LaunchOk {
  ok: true;
  sandboxId: string;
  cmdId: string;
}

export interface LaunchErr {
  ok: false;
  error: string;
}

export interface LaunchTaskSandboxArgs {
  bundleBranch: Branch;
  fnName: string;
  attemptCtx: TaskRunContext;
  timeoutMs: number;
  callbackUrl: string;
  callbackToken: string;
}

/**
 * Launch step. Fetches the bundle, creates the sandbox, writes runner.js +
 * bundle.js, starts the runner detached. Returns immediately with
 * sandboxId and cmdId; the workflow body then suspends on
 * `sandboxDoneHook` until runner.js POSTs back (or the watchdog fires).
 *
 * Persists `sandboxId`, `logUrl`, `logToken` on the attempt row so the
 * browser can open a direct SSE to the sandbox for live logs and so a
 * later clear/cancel can stop the sandbox.
 */
export async function launchTaskSandbox(
  args: LaunchTaskSandboxArgs
): Promise<LaunchOk | LaunchErr> {
  "use step";

  // Verify the DAG YAML hasn't mutated since this run was enqueued. The
  // dispatch path pinned the SHA into dag_runs.manifest_sha at insert
  // time; if the current dags.yamlRaw no longer hashes to that value, the
  // topology (and possibly task parameters) of this DAG changed mid-run
  // and we refuse to launch. NULL manifest_sha means the run pre-dates
  // the column — skip the check for back-compat.
  const [run] = await getDb()
    .select({
      manifestSha: schema.dagRuns.manifestSha,
      branch: schema.dagRuns.branch,
    })
    .from(schema.dagRuns)
    .where(eq(schema.dagRuns.id, args.attemptCtx.dagRunId));
  if (!run) {
    return {
      ok: false,
      error: `dag_runs row not found for runId=${args.attemptCtx.dagRunId}`,
    };
  }
  const [dag] = await getDb()
    .select({ yamlRaw: schema.dags.yamlRaw })
    .from(schema.dags)
    .where(
      and(
        eq(schema.dags.id, args.attemptCtx.dagId),
        eq(schema.dags.branch, run.branch)
      )
    );
  if (!dag) {
    return {
      ok: false,
      error: `dags row not found for dagId=${args.attemptCtx.dagId} branch=${run.branch}`,
    };
  }
  const verify = verifyManifestSha(dag.yamlRaw, run.manifestSha);
  if (!verify.ok) {
    return {
      ok: false,
      error: `manifest_sha mismatch — YAML mutated between enqueue and launch (expected=${verify.expected.slice(0, 12)}…, actual=${verify.actual.slice(0, 12)}…). Re-enqueue the run if you intend to use the new YAML.`,
    };
  }

  let bundleBytes: Buffer;
  try {
    bundleBytes = await fetchBlobBytes(blobPaths.bundle(args.bundleBranch));
  } catch (err) {
    return {
      ok: false,
      error: `bundle fetch from Blob failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Per-attempt random token for the sandbox's public log endpoint. The
  // browser includes this in its EventSource URL; runner.js validates it
  // before streaming logs. The sandbox URL alone is unguessable; this
  // token is defense-in-depth.
  const logToken = randomBytes(32).toString("hex");
  const LOG_PORT = 3000;

  let sandbox: Sandbox;
  try {
    // Extra time so the sandbox stays alive long enough for runner.js to
    // hit its own internal timeout, post the callback, and exit cleanly.
    sandbox = await Sandbox.create({
      timeout: args.timeoutMs + 30_000,
      runtime: "node22",
      ports: [LOG_PORT],
    });
  } catch (err) {
    return {
      ok: false,
      error: `sandbox create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await sandbox.writeFiles([
      { path: "runner.js", content: Buffer.from(RUNNER_TEMPLATE) },
      { path: "bundle.js", content: bundleBytes },
    ]);

    // Mint a Vercel OIDC token to authenticate the sandbox's callback
    // against this project's Deployment Protection. Sandbox lifetime is
    // bounded at `timeoutMs + 30s` (well under OIDC TTL), so a token
    // captured at launch is still valid when runner.js posts back.
    let oidcToken: string | null = null;
    try {
      oidcToken = await getVercelOidcToken();
    } catch (err) {
      try {
        await sandbox.stop();
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        error: `OIDC token unavailable for sandbox callback auth: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // HKDF-derive a per-token signing key from the master HMAC key (which
    // stays in the controller process). The sandbox sees only the derived
    // key — leaking it forges callbacks only for THIS token's tuple.
    const callbackKey = deriveTokenKey(args.callbackToken).toString("hex");

    const sandboxEnv: Record<string, string> = {
      LATTIK_TASK_FN_NAME: args.fnName,
      LATTIK_TASK_CTX: JSON.stringify(args.attemptCtx),
      LATTIK_TASK_TIMEOUT_MS: String(args.timeoutMs),
      LATTIK_TASK_CALLBACK_URL: args.callbackUrl,
      LATTIK_TASK_CALLBACK_KEY: callbackKey,
      LATTIK_TASK_CALLBACK_TOKEN: args.callbackToken,
      LATTIK_TASK_OIDC_TOKEN: oidcToken,
      LATTIK_TASK_LOG_TOKEN: logToken,
      LATTIK_TASK_LOG_PORT: String(LOG_PORT),
    };

    const cmd = await sandbox.runCommand({
      cmd: "node",
      args: ["runner.js"],
      detached: true,
      env: sandboxEnv,
    });

    let logUrl: string | null = null;
    try {
      const origin = sandbox.domain(LOG_PORT);
      logUrl = `${origin.replace(/\/+$/, "")}/logs`;
    } catch (err) {
      // domain() throws if the port wasn't registered. We pass ports above
      // so this shouldn't fire, but tolerate it — live tail is then
      // unavailable but the task still runs.
      console.warn(
        `[launchTaskSandbox] sandbox.domain(${LOG_PORT}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const persistedLogToken = logUrl ? logToken : null;

    await getDb()
      .update(schema.taskAttempts)
      .set({
        sandboxId: sandbox.sandboxId,
        logUrl,
        logToken: persistedLogToken,
      })
      .where(
        and(
          eq(schema.taskAttempts.dagRunId, args.attemptCtx.dagRunId),
          eq(schema.taskAttempts.taskId, args.attemptCtx.taskId),
          eq(schema.taskAttempts.attempt, args.attemptCtx.attempt)
        )
      );

    return { ok: true, sandboxId: sandbox.sandboxId, cmdId: cmd.cmdId };
  } catch (err) {
    try {
      await sandbox.stop();
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      error: `sandbox launch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface FinalizeCtx {
  dagRunId: string;
  taskId: string;
  attempt: number;
}

/**
 * Post-callback finalize step (happy path). Pull full stdout/stderr from
 * the sandbox command, persist them to Blob for the UI, then stop the
 * sandbox. Best-effort: a Blob write failure must not turn a successful
 * task into a failed one.
 */
export async function finalizeTaskSandbox(
  ctx: FinalizeCtx,
  sandboxId: string,
  cmdId: string
): Promise<void> {
  "use step";

  let stdout = "";
  let stderr = "";
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.get({ sandboxId });
    try {
      const cmd = await sandbox.getCommand(cmdId);
      try {
        stdout = await cmd.stdout();
      } catch {
        /* ignore */
      }
      try {
        stderr = await cmd.stderr();
      } catch {
        /* ignore */
      }
    } catch {
      /* command lookup failed — sandbox may have torn down already */
    }
  } catch {
    /* sandbox couldn't be rehydrated — skip log capture */
  }

  await persistLogs(ctx.dagRunId, ctx.taskId, ctx.attempt, stdout, stderr);

  if (sandbox) {
    try {
      await sandbox.stop();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Watchdog step. Only invoked if the hook didn't fire before the deadline.
 * Looks up the command status (e.g. process died without callback),
 * persists any logs we can pull, then force-stops the sandbox.
 */
export async function finalizeMissingCallback(
  ctx: FinalizeCtx,
  sandboxId: string,
  cmdId: string
): Promise<{ exitCode: number | null; stderrTail: string }> {
  "use step";

  let exitCode: number | null = null;
  let stderr = "";
  let stdout = "";
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.get({ sandboxId });
    try {
      const cmd = await sandbox.getCommand(cmdId);
      const ec = (cmd as { exitCode?: number | string | null }).exitCode;
      if (typeof ec === "number") exitCode = ec;
      else if (typeof ec === "string" && ec !== "") exitCode = Number(ec);
      try {
        stdout = await cmd.stdout();
      } catch {
        /* ignore */
      }
      try {
        stderr = await cmd.stderr();
      } catch {
        /* ignore */
      }
    } catch {
      /* command lookup failed; leave defaults */
    }
  } catch {
    /* sandbox couldn't be rehydrated — likely auto-terminated already */
  }

  await persistLogs(ctx.dagRunId, ctx.taskId, ctx.attempt, stdout, stderr);

  if (sandbox) {
    try {
      await sandbox.stop();
    } catch {
      /* best-effort */
    }
  }

  return { exitCode, stderrTail: stderr.slice(-2000) };
}

async function persistLogs(
  dagRunId: string,
  taskId: string,
  attempt: number,
  stdout: string,
  stderr: string
): Promise<void> {
  const body = formatLogBody(stdout, stderr);
  if (!body) return;
  try {
    await putBlobText(blobPaths.taskLog(dagRunId, taskId, attempt), body);
  } catch (err) {
    console.error(
      `failed to persist task log to Blob: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function formatLogBody(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr.startsWith("\n") ? stderr : `\n${stderr}`);
  return parts.join("");
}

/**
 * Upsert a `task_attempts` row. Callers always pass a fresh `attempt`
 * value for a new try, so the ON CONFLICT branch only fires on
 * running → terminal for the same attempt. If a future caller re-uses
 * (dagRunId, taskId, attempt) to flip a row back to running, `startedAt`
 * will NOT be refreshed — add that to the SET clause before introducing
 * such a path.
 */
export async function recordAttempt(
  dagRunId: string,
  taskId: string,
  attempt: number,
  status: "running" | "succeeded" | "failed",
  errorMessage?: string
) {
  "use step";
  await getDb()
    .insert(schema.taskAttempts)
    .values({
      dagRunId,
      taskId,
      attempt,
      status,
      startedAt: status === "running" ? new Date() : undefined,
      finishedAt: status !== "running" ? new Date() : undefined,
      errorMessage,
    })
    .onConflictDoUpdate({
      target: [
        schema.taskAttempts.dagRunId,
        schema.taskAttempts.taskId,
        schema.taskAttempts.attempt,
      ],
      set: {
        status,
        finishedAt: status !== "running" ? new Date() : undefined,
        errorMessage,
      },
    });
}

export function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  // In production the sandbox runs on a Vercel host, not localhost. A
  // missing NEXT_PUBLIC_BASE_URL would point the sandbox at
  // http://localhost:3000/api/internal/sandbox-complete, which never
  // reaches the controller — the watchdog then fires 30s+ later with a
  // useless "no callback within Ns" message. Fail fast at launch so the
  // attempt is recorded as a workflow error with a clear cause.
  if (!base) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_BASE_URL must be set in production — the sandbox callback cannot reach http://localhost:3000 from a Vercel Sandbox host"
      );
    }
    return "http://localhost:3000/api/internal/sandbox-complete";
  }
  return `${base.replace(/\/+$/, "")}/api/internal/sandbox-complete`;
}
