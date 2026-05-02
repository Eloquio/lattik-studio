import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createRequest } from "@/lib/run-queue";

const WORKFLOW_SKILL_ID = "post-pipeline-pr-merge";

interface MergedDefinition {
  id: string;
  kind: string;
  name: string;
  spec: unknown;
}

/** Max webhook payload: 1MB */
const MAX_PAYLOAD_SIZE = 1_048_576;

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
      console.error(err.message);
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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Gitea sends pull_request events with action "closed" and pull_request.merged = true
  if (payload.action !== "closed" || !(payload.pull_request as Record<string, unknown>)?.merged) {
    return Response.json({ status: "ignored" }, { status: 202 });
  }

  const prUrl = (payload.pull_request as Record<string, unknown>)?.html_url as string | undefined;
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

    requestId = await db.transaction(async (tx) => {
      const request = await createRequest(
        "webhook",
        `PR merged: ${prUrl}`,
        context,
        { status: "approved", skillId: WORKFLOW_SKILL_ID, client: tx },
      );
      await tx.insert(schema.runs).values({
        requestId: request.id,
        skillId: WORKFLOW_SKILL_ID,
        description: `Post-merge actions for ${prUrl}`,
        doneCriteria: "All matched per-kind actions completed for the merged definitions.",
        args: { pr_url: prUrl, definitions: mergedDefs },
        status: "pending" as const,
      });
      return request.id;
    });
  }

  return Response.json({
    status: "ok",
    mergedCount: toMerge.length,
    deletedCount: toDelete.length,
    requestId,
  });
}
