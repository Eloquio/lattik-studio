"use server";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

/**
 * Conversation payloads are persisted to a `jsonb` column and reloaded on
 * page refresh. Without an upper bound a runaway agent (or a malicious
 * client driving this server action) could grow a single row to many
 * megabytes — bloating Postgres, slowing the chat panel's initial
 * render, and giving us a write amplification vector against the DB. Cap
 * each component independently so the failure mode is informative.
 */
const MAX_MESSAGES_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CANVAS_STATE_JSON_BYTES = 1 * 1024 * 1024;
const MAX_TASK_STACK_JSON_BYTES = 256 * 1024;

class ConversationPayloadTooLarge extends Error {
  constructor(field: string, size: number, limit: number) {
    super(
      `Conversation field ${field} is too large: ${size} bytes > ${limit} byte limit`,
    );
    this.name = "ConversationPayloadTooLarge";
  }
}

function assertSize(field: string, value: unknown, limit: number): void {
  if (value === undefined || value === null) return;
  // JSON.stringify cost on the cap-sized blobs is microseconds; cheaper than
  // adding a Buffer round-trip just to measure. The DB driver is about to
  // serialize this anyway.
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > limit) throw new ConversationPayloadTooLarge(field, bytes, limit);
}

export async function saveConversation(data: {
  id: string;
  title: string;
  messages: unknown[];
  canvasState?: unknown;
  taskStack?: unknown[];
  activeExtensionId?: string | null;
}) {
  const user = await requireUser();
  const db = getDb();

  assertSize("messages", data.messages, MAX_MESSAGES_JSON_BYTES);
  assertSize("canvasState", data.canvasState, MAX_CANVAS_STATE_JSON_BYTES);
  assertSize("taskStack", data.taskStack, MAX_TASK_STACK_JSON_BYTES);

  // Single atomic UPSERT instead of read-then-write — both prevents the race
  // (concurrent saves of the same chat) and removes the redundant SELECT.
  // Ownership is enforced by the unique (id, userId) pair: a different user
  // can't insert with the same id because it's the primary key, and the
  // ON CONFLICT update sets userId so it can never escape its owner.
  await db
    .insert(schema.conversations)
    .values({
      id: data.id,
      userId: user.id!,
      title: data.title,
      messages: data.messages,
      canvasState: data.canvasState ?? null,
      taskStack: data.taskStack ?? null,
      activeExtensionId: data.activeExtensionId ?? null,
    })
    .onConflictDoUpdate({
      target: schema.conversations.id,
      set: {
        title: data.title,
        messages: data.messages,
        canvasState: data.canvasState ?? null,
        taskStack: data.taskStack ?? null,
        activeExtensionId: data.activeExtensionId ?? null,
        updatedAt: new Date(),
      },
      // Only update if the existing row is owned by the same user — otherwise
      // the conflict resolves to a no-op and we don't leak access.
      setWhere: eq(schema.conversations.userId, user.id!),
    });
}

export async function listConversations() {
  const user = await requireUser();
  const db = getDb();

  return db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, user.id!))
    .orderBy(desc(schema.conversations.updatedAt));
}

export async function getConversation(id: string) {
  const user = await requireUser();
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, id),
        eq(schema.conversations.userId, user.id!)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function deleteConversation(id: string) {
  const user = await requireUser();
  const db = getDb();

  await db
    .delete(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, id),
        eq(schema.conversations.userId, user.id!)
      )
    );
}
