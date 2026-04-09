import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { generateDags } from "@/lib/dag-generator";
import { createLoggerTopic } from "@/lib/kafka-admin";

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
    })
    .from(schema.definitions)
    .where(eq(schema.definitions.prUrl, prUrl));

  if (definitions.length === 0) {
    return Response.json({ status: "ok", updatedCount: 0 });
  }

  // Batch update all matching definitions in one query
  const ids = definitions.map((d) => d.id);
  await db
    .update(schema.definitions)
    .set({
      status: "merged",
      prMergedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(schema.definitions.id, ids));

  // Audit: log each definition merge
  await db.insert(schema.webhookAuditLog).values(
    definitions.map((d) => ({
      prUrl,
      definitionId: d.id,
      action: "definition_merged" as const,
      status: "success" as const,
      detail: `${d.kind} "${d.name}" marked as merged`,
      receivedAt,
    }))
  );

  // Create Kafka topics for any merged Logger Tables.
  for (const def of definitions) {
    if (def.kind === "logger_table") {
      const spec = def.spec as { retention?: string };
      try {
        await createLoggerTopic(def.name, spec.retention ?? "30d");
        await db.insert(schema.webhookAuditLog).values({
          prUrl,
          definitionId: def.id,
          action: "kafka_topic_created",
          status: "success",
          detail: `Topic created for "${def.name}" (retention: ${spec.retention ?? "30d"})`,
          receivedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Kafka topic creation failed for ${def.name}:`, message);
        await db.insert(schema.webhookAuditLog).values({
          prUrl,
          definitionId: def.id,
          action: "kafka_topic_created",
          status: "failure",
          detail: message,
          receivedAt,
        });
      }
    }
  }

  // Regenerate Airflow DAG YAML specs from all merged definitions and push
  // to S3.
  try {
    await generateDags();
    await db.insert(schema.webhookAuditLog).values({
      prUrl,
      action: "dag_generated",
      status: "success",
      detail: `DAGs regenerated after merging ${definitions.length} definition(s)`,
      receivedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DAG generation failed after PR merge:", message);
    await db.insert(schema.webhookAuditLog).values({
      prUrl,
      action: "dag_generated",
      status: "failure",
      detail: message,
      receivedAt,
    });
  }

  return Response.json({
    status: "ok",
    updatedCount: definitions.length,
  });
}
