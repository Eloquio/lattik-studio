import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { z } from "zod";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
import { reconcileDefinitionsFromPR } from "@/lib/reconcile-definitions";
import {
  postPipelineMergeWorkflow,
  type MergedDefinitionRef,
} from "@/workflows/post-pipeline-pr-merge";

const MAX_PAYLOAD_SIZE = 1_048_576;

// Validate just the subset of the GitHub pull_request event we read.
// `passthrough()` keeps unknown fields so GitHub's full payload comes through
// untruncated even though we only act on action + pull_request.{merged,html_url}.
const githubPrEventSchema = z
  .object({
    action: z.string(),
    pull_request: z
      .object({
        merged: z.boolean().optional(),
        html_url: z.string().optional(),
        // PR number — needed to fetch the file diff via the GitHub API.
        number: z.number().optional(),
        // SHA of the squash/merge commit that landed on `main`. We pull
        // file content at this ref so the reconciler sees the post-merge
        // state, not the PR's head branch.
        merge_commit_sha: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

class WebhookSecretMissingError extends Error {
  constructor() {
    super("GITHUB_WEBHOOK_SECRET is not configured. Refusing to accept webhooks.");
  }
}

/**
 * Verify the `X-Hub-Signature-256` header GitHub sends. The header value is
 * `sha256=<hex>`; we strip the prefix and constant-time compare against an
 * HMAC of the raw body using our shared secret.
 *
 * Throws on missing secret so a misconfigured server returns 500 —
 * silent acceptance of unsigned deliveries would be the worst possible
 * failure mode here.
 */
function verifySignature(payload: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookSecretMissingError();
  }
  if (!signature) return false;
  if (!signature.startsWith("sha256=")) return false;
  const hex = signature.slice("sha256=".length);

  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  const sigBuf = Buffer.from(hex, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

export async function POST(req: Request) {
  const remoteIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { allowed, resetAt } = await rateLimit(`github-webhook:${remoteIp}`, {
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!allowed) {
    log.warn("github_webhook.rate_limited", { remoteIp, resetAt });
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil((resetAt - Date.now()) / 1000)) },
      },
    );
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_PAYLOAD_SIZE) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const signature = req.headers.get("x-hub-signature-256");

  let valid = false;
  try {
    valid = verifySignature(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookSecretMissingError) {
      log.error("github_webhook.misconfigured", { error: err.message });
      return Response.json(
        { error: "Server misconfigured: webhook secret missing" },
        { status: 500 },
      );
    }
    throw err;
  }

  if (!valid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // GitHub identifies the event class in this header — `pull_request`,
  // `push`, `ping`, etc. Anything other than pull_request we acknowledge
  // and ignore so GitHub stops retrying. `ping` is GitHub's webhook
  // self-test on creation; returning 200 keeps the UI green.
  const event = req.headers.get("x-github-event");
  if (event === "ping") {
    return Response.json({ status: "pong" });
  }
  if (event !== "pull_request") {
    return Response.json({ status: "ignored", event }, { status: 202 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = githubPrEventSchema.safeParse(rawPayload);
  if (!parsed.success) {
    log.warn("github_webhook.invalid_payload", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return Response.json(
      { error: "Invalid webhook payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  // We only care about merged PRs. GitHub sends action=closed with
  // pull_request.merged=true; action=closed with merged=false is a
  // close-without-merge, which we deliberately ignore.
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    return Response.json({ status: "ignored" }, { status: 202 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) {
    return Response.json({ status: "no_pr_url" }, { status: 202 });
  }
  const prNumber = payload.pull_request?.number;
  const mergeCommitSha = payload.pull_request?.merge_commit_sha;
  if (typeof prNumber !== "number" || !mergeCommitSha) {
    // Without these we can't read the post-merge file content; nothing to
    // reconcile. Ack so GitHub doesn't retry.
    log.warn("github_webhook.missing_pr_metadata", {
      prUrl,
      hasNumber: typeof prNumber === "number",
      hasMergeSha: Boolean(mergeCommitSha),
    });
    return Response.json({ status: "missing_pr_metadata" }, { status: 202 });
  }

  const db = getDb();
  const receivedAt = new Date();

  // Reconcile DB against the YAML files actually changed in the PR. Git is
  // the source of truth — Lattik-authored PRs and hand-edited ones go
  // through the same code path here.
  let reconcileResult: Awaited<ReturnType<typeof reconcileDefinitionsFromPR>>;
  try {
    reconcileResult = await reconcileDefinitionsFromPR({
      prUrl,
      prNumber,
      mergeCommitSha,
    });
  } catch (err) {
    log.error("github_webhook.reconcile_failed", {
      pr_url: prUrl,
      pr_number: prNumber,
      merge_sha: mergeCommitSha,
      error: err instanceof Error ? err.message : String(err),
    });
    // Still surface a workflow row so /workflows shows the failure, then
    // bail with 500 so GitHub retries.
    const pipelineRunId = randomUUID();
    await db.insert(schema.pipelineWorkflowRuns).values({
      id: pipelineRunId,
      workflowName: "post-pipeline-pr-merge",
      status: "failed",
      prUrl,
      input: { prNumber, mergeCommitSha },
      finishedAt: new Date(),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "Failed to reconcile definitions from PR" },
      { status: 500 },
    );
  }

  // Fan out the reconciliation outcome into the audit log so /workflows can
  // show "Added: …", "Modified: …", "Deleted: …", "Invalid: …".
  const auditRows = [
    ...reconcileResult.added.map((d) => ({
      prUrl,
      definitionId: d.definitionId,
      action: "definition_added" as const,
      status: "success" as const,
      detail: `${d.kind} "${d.name}" added`,
      receivedAt,
    })),
    ...reconcileResult.modified.map((d) => ({
      prUrl,
      definitionId: d.definitionId,
      action: "definition_modified" as const,
      status: "success" as const,
      detail: `${d.kind} "${d.name}" modified`,
      receivedAt,
    })),
    ...reconcileResult.deleted.map((d) => ({
      prUrl,
      definitionId: d.definitionId,
      action: "definition_deleted" as const,
      status: "success" as const,
      detail: `${d.kind} "${d.name}" deleted`,
      receivedAt,
    })),
    ...reconcileResult.invalid.map((d) => ({
      prUrl,
      definitionId: d.definitionId,
      action: "validation_failed" as const,
      status: "failure" as const,
      detail: `${d.kind} "${d.name}": ${d.error}`,
      receivedAt,
    })),
  ];
  if (auditRows.length > 0) {
    await db.insert(schema.webhookAuditLog).values(auditRows);
  }

  // The downstream workflow only cares about defs that ended up valid —
  // invalid rows are intentionally excluded so DAG / Kafka / Schema Registry
  // steps don't operate on broken specs.
  const validRefs = [...reconcileResult.added, ...reconcileResult.modified];
  const mergedDefs: MergedDefinitionRef[] = validRefs.map((d) => ({
    id: d.definitionId,
    kind: d.kind,
    name: d.name,
    // The reconciler already wrote the validated spec into the DB; the
    // workflow can re-read by id when it needs it. Carry an empty spec
    // through the workflow input so we don't bloat it with full JSON
    // payloads for large lattik tables.
    spec: {},
  }));

  // GitHub may redeliver the same x-github-delivery on transient
  // failure. The ack-only workflow is safe to replay, but once real
  // side effects land here we'll need an app-level dedup keyed on
  // x-github-delivery.
  const ghDeliveryId = req.headers.get("x-github-delivery") ?? randomUUID();
  const pipelineRunId = randomUUID();

  // Insert the row *before* start() so a fast workflow can't outrun
  // the insert — its terminal step updates this row by id.
  try {
    await db.insert(schema.pipelineWorkflowRuns).values({
      id: pipelineRunId,
      workflowName: "post-pipeline-pr-merge",
      status: "running",
      prUrl,
      input: {
        ghDeliveryId,
        definitionIds: mergedDefs.map((d) => d.id),
        definitionKinds: mergedDefs.map((d) => d.kind),
      },
    });
  } catch (err) {
    log.error("github_webhook.workflow_run_insert_failed", {
      pipeline_run_id: pipelineRunId,
      pr_url: prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "Failed to record workflow run" },
      { status: 500 },
    );
  }

  let requestId: string | undefined;
  try {
    const run = await start(postPipelineMergeWorkflow, [
      { pipelineRunId, prUrl, ghDeliveryId, definitions: mergedDefs },
    ]);
    requestId = run.runId;
  } catch (err) {
    log.error("github_webhook.workflow_start_failed", {
      pipeline_run_id: pipelineRunId,
      pr_url: prUrl,
      gh_delivery_id: ghDeliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    await db
      .update(schema.pipelineWorkflowRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage:
          err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.pipelineWorkflowRuns.id, pipelineRunId));
    return Response.json(
      { error: "Failed to start post-merge workflow" },
      { status: 500 },
    );
  }

  return Response.json({
    status: "ok",
    addedCount: reconcileResult.added.length,
    modifiedCount: reconcileResult.modified.length,
    deletedCount: reconcileResult.deleted.length,
    invalidCount: reconcileResult.invalid.length,
    requestId,
  });
}
