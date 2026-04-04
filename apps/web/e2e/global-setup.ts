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

  // Seed the data-architect agent
  await db
    .insert(schema.agents)
    .values({
      id: "data-architect",
      name: "Data Architect",
      description:
        "Design pipeline architectures: Logger Tables, Lattik Tables, and Canonical Dimensions.",
      icon: "blocks",
      category: "Data Architecture",
      type: "first-party",
      published: true,
    })
    .onConflictDoUpdate({
      target: schema.agents.id,
      set: {
        name: "Data Architect",
        description:
          "Design pipeline architectures: Logger Tables, Lattik Tables, and Canonical Dimensions.",
      },
    });

  // Enable data-architect for the test user
  await db
    .insert(schema.userAgents)
    .values({ userId: TEST_USER_ID, agentId: "data-architect" })
    .onConflictDoNothing();

  // Write state to file so fixtures can read it (cross-process)
  writeFileSync(STATE_FILE, JSON.stringify({ sessionToken: TEST_SESSION_TOKEN }));

  await client.end();
}

export default globalSetup;
