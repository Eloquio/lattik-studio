"use server";

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import type { DefinitionKind, DefinitionStatus } from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

export async function createDefinition(data: {
  kind: DefinitionKind;
  name: string;
  spec: unknown;
}) {
  const user = await requireUser();
  const db = getDb();

  const [row] = await db
    .insert(schema.definitions)
    .values({
      kind: data.kind,
      name: data.name,
      spec: data.spec,
      createdBy: user.id!,
    })
    .returning();

  return row;
}

export async function updateDefinition(
  id: string,
  data: { name?: string; spec?: unknown; status?: DefinitionStatus; prUrl?: string }
) {
  const user = await requireUser();
  const db = getDb();

  // Verify the user owns this definition
  const existing = await db
    .select({ id: schema.definitions.id })
    .from(schema.definitions)
    .where(
      and(
        eq(schema.definitions.id, id),
        eq(schema.definitions.createdBy, user.id!)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    throw new Error("Definition not found or unauthorized");
  }

  const [row] = await db
    .update(schema.definitions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.definitions.id, id))
    .returning();

  return row;
}

export async function getDefinition(id: string) {
  await requireUser();
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function getDefinitionByName(kind: DefinitionKind, name: string) {
  await requireUser();
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.definitions)
    .where(
      and(
        eq(schema.definitions.kind, kind),
        eq(schema.definitions.name, name)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listDefinitions(kind?: DefinitionKind) {
  await requireUser();
  const db = getDb();

  if (kind) {
    return db
      .select()
      .from(schema.definitions)
      .where(eq(schema.definitions.kind, kind))
      .orderBy(desc(schema.definitions.updatedAt));
  }

  return db
    .select()
    .from(schema.definitions)
    .orderBy(desc(schema.definitions.updatedAt));
}

export async function listMergedDefinitions(kind?: DefinitionKind) {
  await requireUser();
  const db = getDb();

  if (kind) {
    return db
      .select()
      .from(schema.definitions)
      .where(
        and(
          eq(schema.definitions.kind, kind),
          eq(schema.definitions.status, "merged")
        )
      )
      .orderBy(desc(schema.definitions.updatedAt));
  }

  return db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.status, "merged"))
    .orderBy(desc(schema.definitions.updatedAt));
}
