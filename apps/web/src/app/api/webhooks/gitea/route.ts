import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

/** Max webhook payload: 1MB */
const MAX_PAYLOAD_SIZE = 1_048_576;

function verifySignature(payload: string, signature: string | null): boolean {
  const secret = process.env.GITEA_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;

  const crypto = require("crypto") as typeof import("crypto");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
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

  if (!verifySignature(rawBody, signature)) {
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

  // Find definitions with this PR URL
  const definitions = await db
    .select({ id: schema.definitions.id })
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

  return Response.json({
    status: "ok",
    updatedCount: definitions.length,
  });
}
