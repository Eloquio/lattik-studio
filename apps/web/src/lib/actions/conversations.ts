"use server";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

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
      canvasState: data.canvasState ?? undefined,
      taskStack: data.taskStack ?? undefined,
      activeExtensionId: data.activeExtensionId ?? null,
    })
    .onConflictDoUpdate({
      target: schema.conversations.id,
      set: {
        title: data.title,
        messages: data.messages,
        canvasState: data.canvasState ?? undefined,
        taskStack: data.taskStack ?? undefined,
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
