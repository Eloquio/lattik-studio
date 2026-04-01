import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  db: PostgresJsDatabase<typeof schema>;
};

export function getDb() {
  if (!globalForDb.db) {
    const client = postgres(process.env.DATABASE_URL!);
    globalForDb.db = drizzle(client, { schema });
  }
  return globalForDb.db;
}

export type Database = PostgresJsDatabase<typeof schema>;
