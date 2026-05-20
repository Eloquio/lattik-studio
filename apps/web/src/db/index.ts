import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  db: PostgresJsDatabase<typeof schema>;
};

export function getDb() {
  if (!globalForDb.db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      // Surface the misconfiguration cleanly on first DB use rather than
      // letting `postgres(undefined)` fail deeper in the driver with a
      // generic "client cannot be undefined" / connection-refused message.
      throw new Error(
        "DATABASE_URL is required. Run `pnpm dev:bootstrap` or set it explicitly.",
      );
    }
    const client = postgres(url);
    globalForDb.db = drizzle(client, { schema });
  }
  return globalForDb.db;
}

export type Database = PostgresJsDatabase<typeof schema>;
