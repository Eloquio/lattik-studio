/**
 * Definition queries used by Data Architect's tools.
 *
 * Scoped to this extension — the queries are short enough that pulling
 * them from a shared lib would add more friction than copy. If a third
 * agent ends up needing the same queries, lift them into
 * `apps/agent-service/src/lib/definitions.ts` then.
 *
 * Differs from apps/web's `lib/actions/definitions.ts` in two ways:
 *   1. No `"use server"` — agent-service is a Nitro API service, every
 *      module already runs server-side.
 *   2. Caller passes `userId` explicitly when needed (createdBy on
 *      insert). agent-service's auth model is "trusted client asserts
 *      X-User-Id" so the user identity comes from a route param, not
 *      from a NextAuth session.
 */

import { eq, and, desc } from "drizzle-orm";
import {
  definitions,
  type DefinitionKind,
  type DefinitionStatus,
} from "@eloquio/db-schema";
import { getDb } from "../../../lib/db.js";

export async function listDefinitions(opts?: {
  kind?: DefinitionKind;
  status?: DefinitionStatus;
}) {
  const db = getDb();
  const wheres = [];
  if (opts?.kind) wheres.push(eq(definitions.kind, opts.kind));
  if (opts?.status) wheres.push(eq(definitions.status, opts.status));

  return db
    .select({
      id: definitions.id,
      kind: definitions.kind,
      name: definitions.name,
      version: definitions.version,
      status: definitions.status,
      updatedAt: definitions.updatedAt,
    })
    .from(definitions)
    .where(wheres.length > 0 ? and(...wheres) : undefined)
    .orderBy(desc(definitions.updatedAt));
}

export async function getDefinitionByName(kind: DefinitionKind, name: string) {
  const [row] = await getDb()
    .select()
    .from(definitions)
    .where(and(eq(definitions.kind, kind), eq(definitions.name, name)))
    .limit(1);
  return row ?? null;
}

/**
 * Return all merged definitions, optionally filtered by kind. Used by the
 * referential validator to verify that an Entity / Dimension / Table the
 * draft references actually exists in production. Only `merged` rows count
 * — drafts and pending PRs aren't authoritative.
 *
 * Limit defaults to 1000 (the validator's REFERENTIAL_LIMIT) and is
 * clamped to a max of 1000 — referential checks load every merged
 * definition into memory and we don't want pathological queries to drag
 * the service down.
 */
export async function listMergedDefinitions(
  kind?: DefinitionKind,
  limit = 1000,
) {
  const wheres = [eq(definitions.status, "merged" as const)];
  if (kind) wheres.push(eq(definitions.kind, kind));
  const take = Math.min(Math.max(limit, 1), 1000);
  return getDb()
    .select()
    .from(definitions)
    .where(and(...wheres))
    .limit(take);
}

export async function createDefinition(data: {
  kind: DefinitionKind;
  name: string;
  spec: unknown;
  userId: string;
}) {
  const [row] = await getDb()
    .insert(definitions)
    .values({
      kind: data.kind,
      name: data.name,
      spec: data.spec,
      status: "draft",
      createdBy: data.userId,
    })
    .returning();
  return row;
}

export async function updateDefinition(id: string, patch: { spec: unknown }) {
  const [row] = await getDb()
    .update(definitions)
    .set({ spec: patch.spec, updatedAt: new Date() })
    .where(eq(definitions.id, id))
    .returning();
  return row;
}
