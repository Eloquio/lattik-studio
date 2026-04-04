import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

const TEST_USER_ID = "test-user-id-e2e";

async function globalTeardown() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://lattik:lattik-local@localhost:5432/lattik_studio";

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  // Clean up in reverse dependency order
  await db.delete(schema.conversations).where(eq(schema.conversations.userId, TEST_USER_ID));
  await db.delete(schema.userAgents).where(eq(schema.userAgents.userId, TEST_USER_ID));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, TEST_USER_ID));
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, TEST_USER_ID));
  await db.delete(schema.users).where(eq(schema.users.id, TEST_USER_ID));

  await client.end();
}

export default globalTeardown;
