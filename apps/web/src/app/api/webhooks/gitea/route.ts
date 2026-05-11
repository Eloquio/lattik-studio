import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";

const WORKFLOW_SKILL_ID = "post-pipeline-pr-merge";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3939";

interface MergedDefinition {
  id: string;
  kind: string;
  name: string;
  spec: unknown;
}

/** Max webhook payload: 1MB */
const MAX_PAYLOAD_SIZE = 1_048_576;

// Validate just the subset of the Gitea pull_request event that this handler
// reads. We use `.passthrough()` on the inner object so we don't drop fields
// Gitea sends — we only care about action + pull_request.{merged,html_url}.
const giteaPrEventSchema = z
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
    super("GITEA_WEBHOOK_SECRET is not configured. Refusing to accept webhooks.");
  }
}

function verifySignature(payload: string, signature: string | null): boolean {
  // The previous implementation returned `false` for both "secret missing"
  // and "signature mismatch". That conflation meant a misconfigured server
  // (no secret in env) silently accepted no webhooks AND, worse, masked the
  // misconfiguration so an operator would never realize that the integration
  // was fundamentally unsigned. Throw instead, so the route handler returns
  // 500 and the operator sees the failure immediately.
  const secret = process.env.GITEA_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookSecretMissingError();
  }
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  // timingSafeEqual requires equal-length buffers — comparing an attacker-
  // supplied signature of arbitrary length would otherwise throw and leak
  // through. Length-check first, then compare.
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

export async function POST(req: Request) {
  // Rate-limit per remote IP. Gitea webhooks come from a small set of source
  // IPs in practice, so this protects against a misconfigured (or malicious)
  // Gitea instance flooding us; legitimate deliveries are nowhere near 60/min.
  const remoteIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { allowed, resetAt } = await rateLimit(`gitea-webhook:${remoteIp}`, {
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!allowed) {
    log.warn("gitea_webhook.rate_limited", { remoteIp, resetAt });
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil((resetAt - Date.now()) / 1000)) },
      },
    );
  }

  // Check payload size before reading
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const rawBody = await req.text();

  if (rawBody.length > MAX_PAYLOAD_SIZE) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const signature = req.headers.get("x-gitea-signature");

  let valid = false;
  try {
    valid = verifySignature(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookSecretMissingError) {
      log.error("gitea_webhook.misconfigured", { error: err.message });
      return Response.json(
        { error: "Server misconfigured: webhook secret missing" },
        { status: 500 }
      );
    }
    throw err;
  }

  if (!valid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = giteaPrEventSchema.safeParse(rawPayload);
  if (!parsed.success) {
    log.warn("gitea_webhook.invalid_payload", {
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

  // Gitea sends pull_request events with action "closed" and pull_request.merged = true
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    return Response.json({ status: "ignored" }, { status: 202 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) {
    return Response.json({ status: "no_pr_url" }, { status: 202 });
  }

  const db = getDb();
  const receivedAt = new Date();

  // Find definitions with this PR URL
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

  // Rows flipped to `pending_deletion` by the deleteDefinition tool are tied
  // to a deletion PR — when that PR merges, the YAML file is gone from the
  // repo and we must drop the row so it stops showing up as a committed
  // definition in the reviewer's workspace context.
  const toDelete = definitions.filter((d) => d.status === "pending_deletion");
  const toMerge = definitions.filter((d) => d.status !== "pending_deletion");

  if (toDelete.length > 0) {
    // Audit rows must be inserted before the delete so they still carry a
    // valid `definitionId`. The FK is ON DELETE SET NULL, so subsequent
    // lookups won't break — but populating it at insert time preserves the
    // direct link for as long as possible.
    await db.insert(schema.webhookAuditLog).values(
      toDelete.map((d) => ({
        prUrl,
        definitionId: d.id,
        action: "definition_deleted" as const,
        status: "success" as const,
        detail: `${d.kind} "${d.name}" deleted after deletion PR merged`,
        receivedAt,
      }))
    );
    await db
      .delete(schema.definitions)
      .where(inArray(schema.definitions.id, toDelete.map((d) => d.id)));
  }

  let requestId: string | undefined;
  if (toMerge.length > 0) {
    await db
      .update(schema.definitions)
      .set({
        status: "merged",
        prMergedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(schema.definitions.id, toMerge.map((d) => d.id)));

    await db.insert(schema.webhookAuditLog).values(
      toMerge.map((d) => ({
        prUrl,
        definitionId: d.id,
        action: "definition_merged" as const,
        status: "success" as const,
        detail: `${d.kind} "${d.name}" marked as merged`,
        receivedAt,
      }))
    );

    // Webhook fan-out: register one request + one run pointing at the
    // `post-pipeline-pr-merge` workflow skill. The Executor Agent reads
    // the merged definitions from args and branches per kind in its
    // runbook. The request lands at `approved` and the run at `pending`
    // in one transaction so the Executor picks it up directly — no LLM
    // Planner hop.
    const mergedDefs: MergedDefinition[] = toMerge.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      spec: d.spec,
    }));

    const context = {
      prUrl,
      definitions: mergedDefs,
      receivedAt: receivedAt.toISOString(),
    };

    // Trigger the post-merge skill via agent-service's workflow
    // endpoint. Replaces the old run-queue path (insert Request +
    // Run; agent-worker pod polls and claims). Fire-and-forget — the
    // workflow runs durably inside Vercel Workflow's runtime and
    // doesn't need this response to wait on it. We capture the
    // workflowRunId from the synchronous response purely for the
    // webhook's audit log.
    requestId = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const skillRunBody = {
      runId: requestId,
      skillId: WORKFLOW_SKILL_ID,
      args: { pr_url: prUrl, definitions: mergedDefs },
    };
    void context; // assembled above for the audit context but no longer persisted
    fetch(`${AGENT_SERVICE_URL}/__wf-skill-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trusted-client auth — agent-service's middleware validates the
        // X-Client-Id is in LATTIK_DEV_TRUSTED_CLIENTS. No user identity
        // is needed for skill runs (they're system-triggered).
        "X-Client-Id": "web",
        "X-User-Id": "system:webhook",
      },
      body: JSON.stringify(skillRunBody),
    }).catch((err) => {
      // Non-blocking — log and move on. The webhook's job is to
      // acknowledge Gitea's delivery, not to wait on the workflow.
      log.error("gitea_webhook.skill_dispatch_failed", {
        pr_url: prUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return Response.json({
    status: "ok",
    mergedCount: toMerge.length,
    deletedCount: toDelete.length,
    requestId,
  });
}
