"use server";

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

export async function saveConversation(data: {
  id: string;
  title: string;
  messages: unknown[];
}) {
  const user = await requireUser();
  const db = getDb();
  const messagesJson = JSON.parse(JSON.stringify(data.messages));

  const existing = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, data.id),
        eq(schema.conversations.userId, user.id!)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(schema.conversations)
      .set({
        title: data.title,
        messages: messagesJson,
        updatedAt: new Date(),
      })
      .where(eq(schema.conversations.id, data.id));
  } else {
    await db.insert(schema.conversations).values({
      id: data.id,
      userId: user.id!,
      title: data.title,
      messages: messagesJson,
    });
  }
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
