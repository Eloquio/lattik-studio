"use server";

import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

export async function listAllRequests() {
  await requireUser();
  const db = getDb();

  return db
    .select({
      id: schema.requests.id,
      source: schema.requests.source,
      description: schema.requests.description,
      status: schema.requests.status,
      skillId: schema.requests.skillId,
      createdAt: schema.requests.createdAt,
      updatedAt: schema.requests.updatedAt,
    })
    .from(schema.requests)
    .orderBy(desc(schema.requests.createdAt))
    .limit(100);
}

export async function getRequestDetail(id: string) {
  await requireUser();
  const db = getDb();

  const [request] = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.id, id))
    .limit(1);

  if (!request) return null;

  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.requestId, id))
    .orderBy(asc(schema.tasks.createdAt));

  return { request, tasks };
}
