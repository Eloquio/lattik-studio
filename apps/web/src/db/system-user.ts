import { eq } from "drizzle-orm";
import type { getDb } from "./index";
import * as schema from "./schema";

// Pinned id so hand-made GitHub PRs that don't carry a Lattik user can still
// satisfy the `definitions.createdBy` FK. The merge webhook upserts rows with
// `createdBy = SYSTEM_USER_ID` on insert; existing rows keep their original
// owner on conflict. Safe in production — this user can't sign in (no
// password, no OAuth identity).
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-00000000005e";
export const SYSTEM_USER_EMAIL = "system@lattik.local";
export const SYSTEM_USER_NAME = "Lattik System";

export async function upsertSystemUser(db: ReturnType<typeof getDb>) {
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, SYSTEM_USER_ID));
  if (existing.length > 0) return existing[0];
  const [row] = await db
    .insert(schema.users)
    .values({
      id: SYSTEM_USER_ID,
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
    })
    .returning();
  return row;
}
