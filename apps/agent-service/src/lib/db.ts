/**
 * Drizzle client for agent-service.
 *
 * Reads/writes the same postgres instance as apps/web — both apps import
 * the schema from @eloquio/db-schema, so adding a column to (e.g.)
 * `conversations` is a one-place change. The connection is a singleton
 * keyed on `globalThis` so HMR/dev reloads don't accumulate clients.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@eloquio/db-schema";

const globalForDb = globalThis as unknown as {
  agentServiceDb?: PostgresJsDatabase<typeof schema>;
};

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!globalForDb.agentServiceDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — agent-service can't reach postgres",
      );
    }
    const client = postgres(url);
    globalForDb.agentServiceDb = drizzle(client, { schema });
  }
  return globalForDb.agentServiceDb;
}

export type Database = PostgresJsDatabase<typeof schema>;
