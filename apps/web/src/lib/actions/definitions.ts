"use server";

import { eq, and, desc, or } from "drizzle-orm";
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

  // Ownership check is part of the UPDATE itself — a separate SELECT-then-UPDATE
  // is racy: another request could rewrite the row's createdBy between the two
  // statements, and PostgreSQL would happily run the UPDATE on the wrong row.
  const [row] = await db
    .update(schema.definitions)
    .set({ ...data, updatedAt: new Date() })
    .where(
      and(
        eq(schema.definitions.id, id),
        eq(schema.definitions.createdBy, user.id!)
      )
    )
    .returning();

  if (!row) {
    throw new Error("Definition not found or unauthorized");
  }

  return row;
}

/**
 * Mark a definition row as awaiting a deletion PR merge. Any authenticated
 * user may flip a merged (shared) definition into `pending_deletion` — the
 * Gitea PR itself is what gates the actual data change, and the webhook is
 * the only thing that consummates the DB cleanup on merge. The ownership
 * check that `updateDefinition` enforces is therefore deliberately skipped
 * here; without that, a user could never propose deletion of a definition
 * they did not originally author.
 */
export async function markDefinitionPendingDeletion(
  id: string,
  prUrl: string
) {
  await requireUser();
  const db = getDb();

  const [row] = await db
    .update(schema.definitions)
    .set({
      status: "pending_deletion",
      prUrl,
      updatedAt: new Date(),
    })
    .where(eq(schema.definitions.id, id))
    .returning();

  if (!row) {
    throw new Error(`Definition ${id} not found`);
  }

  return row;
}

export async function getDefinition(id: string) {
  const user = await requireUser();
  const db = getDb();

  // User can see their own definitions + any merged definitions
  const rows = await db
    .select()
    .from(schema.definitions)
    .where(
      and(
        eq(schema.definitions.id, id),
        or(
          eq(schema.definitions.createdBy, user.id!),
          eq(schema.definitions.status, "merged")
        )
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function getDefinitionByName(kind: DefinitionKind, name: string) {
  const user = await requireUser();
  const db = getDb();

  // User can see their own definitions + any merged definitions
  const rows = await db
    .select()
    .from(schema.definitions)
    .where(
      and(
        eq(schema.definitions.kind, kind),
        eq(schema.definitions.name, name),
        or(
          eq(schema.definitions.createdBy, user.id!),
          eq(schema.definitions.status, "merged")
        )
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export async function listDefinitions(kind?: DefinitionKind, limit = DEFAULT_LIMIT) {
  const user = await requireUser();
  const db = getDb();
  const take = Math.min(Math.max(limit, 1), MAX_LIMIT);

  // User sees their own definitions + all merged definitions
  const userOrMerged = or(
    eq(schema.definitions.createdBy, user.id!),
    eq(schema.definitions.status, "merged")
  );

  if (kind) {
    return db
      .select()
      .from(schema.definitions)
      .where(and(eq(schema.definitions.kind, kind), userOrMerged))
      .orderBy(desc(schema.definitions.updatedAt))
      .limit(take);
  }

  return db
    .select()
    .from(schema.definitions)
    .where(userOrMerged)
    .orderBy(desc(schema.definitions.updatedAt))
    .limit(take);
}

export async function listMergedDefinitions(kind?: DefinitionKind, limit = DEFAULT_LIMIT) {
  await requireUser();
  const db = getDb();
  const take = Math.min(Math.max(limit, 1), MAX_LIMIT);

  // Merged definitions are shared — all users can see them
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
      .orderBy(desc(schema.definitions.updatedAt))
      .limit(take);
  }

  return db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.status, "merged"))
    .orderBy(desc(schema.definitions.updatedAt))
    .limit(take);
}
