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
  const db = getDb();

  const [row] = await db
    .update(schema.definitions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.definitions.id, id))
    .returning();

  return row;
}

export async function getDefinition(id: string) {
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function getDefinitionByName(kind: DefinitionKind, name: string) {
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
  const db = getDb();

  const query = db
    .select()
    .from(schema.definitions)
    .orderBy(desc(schema.definitions.updatedAt));

  if (kind) {
    return query.where(eq(schema.definitions.kind, kind));
  }

  return query;
}

export async function listMergedDefinitions(kind?: DefinitionKind) {
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
