import { eq } from "drizzle-orm";
import type { getDb } from "./index";
import * as schema from "./schema";

// Pinned across cluster resets so NextAuth JWTs stay valid after `pnpm dev:down
// → dev:bootstrap`. Without this, the seed creates a fresh UUID, the existing
// browser cookie still references the old id, and conversation inserts fail
// the userId FK on the user table.
export const DEV_ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_ADMIN_EMAIL = "admin@lattik.local";
export const DEV_ADMIN_NAME = "Lattik Admin";

export async function upsertDevAdmin(db: ReturnType<typeof getDb>) {
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, DEV_ADMIN_USER_ID));
  if (existing.length > 0) return existing[0];
  const [row] = await db
    .insert(schema.users)
    .values({
      id: DEV_ADMIN_USER_ID,
      email: DEV_ADMIN_EMAIL,
      name: DEV_ADMIN_NAME,
    })
    .returning();
  return row;
}
