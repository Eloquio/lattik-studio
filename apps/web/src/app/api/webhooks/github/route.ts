import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { start } from "workflow/api";
import { z } from "zod";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
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

  const db = getDb();
  const receivedAt = new Date();

  const definitions = await db
    .select({
      id: schema.definitions.id,
      kind: schema.definitions.kind,
      name: schema.definitions.name,
      spec: schema.definitions.spec,
      status: schema.definitions.status,
    })
    .from(schema.definitions)
    .where(eq(schema.definitions.prUrl, prUrl));

  if (definitions.length === 0) {
    return Response.json({ status: "ok", mergedCount: 0, deletedCount: 0 });
  }

  const toDelete = definitions.filter((d) => d.status === "pending_deletion");
  const toMerge = definitions.filter((d) => d.status !== "pending_deletion");

  if (toDelete.length > 0) {
    await db.insert(schema.webhookAuditLog).values(
      toDelete.map((d) => ({
        prUrl,
        definitionId: d.id,
        action: "definition_deleted" as const,
        status: "success" as const,
        detail: `${d.kind} "${d.name}" deleted after deletion PR merged`,
        receivedAt,
      })),
    );
    await db
      .delete(schema.definitions)
      .where(inArray(schema.definitions.id, toDelete.map((d) => d.id)));
  }

  let requestId: string | undefined;
  if (toMerge.length > 0) {
    await Promise.all([
      db
        .update(schema.definitions)
        .set({
          status: "merged",
          prMergedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(schema.definitions.id, toMerge.map((d) => d.id))),
      db.insert(schema.webhookAuditLog).values(
        toMerge.map((d) => ({
          prUrl,
          definitionId: d.id,
          action: "definition_merged" as const,
          status: "success" as const,
          detail: `${d.kind} "${d.name}" marked as merged`,
          receivedAt,
        })),
      ),
    ]);

    const mergedDefs: MergedDefinitionRef[] = toMerge.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      spec: d.spec,
    }));

    // Start the post-merge workflow in-process via WDK. We generate
    // `pipelineRunId` ourselves and pass it into the workflow so its
    // terminal step can update the row by a known key — WDK 4.x doesn't
    // surface its own runId from inside a workflow body. The row is
    // inserted *before* start() so a fast workflow can't outrun the
    // insert.
    //
    // GitHub may redeliver the same x-github-delivery on transient
    // failure. The ack-only workflow is safe to replay, but once real
    // side effects land here we'll need an app-level dedup keyed on
    // x-github-delivery.
    const ghDeliveryId = req.headers.get("x-github-delivery") ?? randomUUID();
    const pipelineRunId = randomUUID();

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
      // Mark the row failed so the listing reflects the truth — the run
      // never actually started.
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
  }

  return Response.json({
    status: "ok",
    mergedCount: toMerge.length,
    deletedCount: toDelete.length,
    requestId,
  });
}
