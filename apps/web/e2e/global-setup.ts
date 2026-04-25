import { writeFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

export const TEST_USER_ID = "test-user-id-e2e";
export const TEST_SESSION_TOKEN = "e2e-stable-session-token-lattik-studio";

const STATE_FILE = join(__dirname, ".test-state.json");

async function globalSetup() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://lattik:lattik-local@localhost:5432/lattik_studio";

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  // Clean up any stale test data first
  await db.delete(schema.sessions).where(eq(schema.sessions.sessionToken, TEST_SESSION_TOKEN));
  await db.delete(schema.conversations).where(eq(schema.conversations.userId, TEST_USER_ID));

  // Seed test user
  await db
    .insert(schema.users)
    .values({
      id: TEST_USER_ID,
      name: "Test User",
      email: "test@lattik.dev",
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: { name: "Test User", email: "test@lattik.dev" },
    });

  // Seed session (expires 1 year from now)
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  await db.insert(schema.sessions).values({
    sessionToken: TEST_SESSION_TOKEN,
    userId: TEST_USER_ID,
    expires,
  });

  // Chat specialists (data-architect, etc.) are now registered in the TS
  // extensions registry rather than seeded as DB rows. No agent table to
  // seed against.

  // Write state to file so fixtures can read it (cross-process)
  writeFileSync(STATE_FILE, JSON.stringify({ sessionToken: TEST_SESSION_TOKEN }));

  await client.end();
}

export default globalSetup;
