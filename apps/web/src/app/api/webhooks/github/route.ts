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
 * Mirrors the gitea variant in spirit but with two protocol-level diffs:
 * (1) the prefix, (2) the header name. Throws on missing secret so a
 * misconfigured server returns 500 — silent acceptance of unsigned
 * deliveries would be the worst possible failure mode here.
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

    const mergedDefs: MergedDefinition[] = toMerge.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      spec: d.spec,
    }));

    // Dispatch the post-merge skill via agent-service. NOTE: agent-service
    // isn't yet redeployed after the Phase 1 collapse, so this fetch will
    // fail in prod — the .catch below downgrades that to a log line. The
    // PR-state DB updates above still commit, which is the load-bearing
    // half of this handler. Phase 2 of the agent-service collapse will
    // turn this into a direct in-process workflow.start().
    requestId = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const skillRunBody = {
      runId: requestId,
      skillId: WORKFLOW_SKILL_ID,
      args: { pr_url: prUrl, definitions: mergedDefs },
    };
    fetch(`${AGENT_SERVICE_URL}/__wf-skill-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": "web",
        "X-User-Id": "system:webhook",
      },
      body: JSON.stringify(skillRunBody),
    }).catch((err) => {
      log.error("github_webhook.skill_dispatch_failed", {
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
