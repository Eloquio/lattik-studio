"use server";

import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

export async function listAgents() {
  const db = getDb();
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.published, true));
}

export async function listEnabledAgents() {
  const user = await requireUser();
  const db = getDb();

  const rows = await db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      description: schema.agents.description,
      icon: schema.agents.icon,
      category: schema.agents.category,
      type: schema.agents.type,
      config: schema.agents.config,
    })
    .from(schema.userAgents)
    .innerJoin(schema.agents, eq(schema.userAgents.agentId, schema.agents.id))
    .where(eq(schema.userAgents.userId, user.id!));

  return rows;
}

export async function enableAgent(agentId: string) {
  const user = await requireUser();
  const db = getDb();

  await db
    .insert(schema.userAgents)
    .values({ userId: user.id!, agentId })
    .onConflictDoNothing();
}

export async function disableAgent(agentId: string) {
  const user = await requireUser();
  const db = getDb();

  await db
    .delete(schema.userAgents)
    .where(
      and(
        eq(schema.userAgents.userId, user.id!),
        eq(schema.userAgents.agentId, agentId)
      )
    );
}

export async function getUserEnabledAgentIds() {
  const user = await requireUser();
  const db = getDb();

  const rows = await db
    .select({ agentId: schema.userAgents.agentId })
    .from(schema.userAgents)
    .where(eq(schema.userAgents.userId, user.id!));

  return new Set(rows.map((r) => r.agentId));
}
