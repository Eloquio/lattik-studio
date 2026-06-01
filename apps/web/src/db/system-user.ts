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
  // Race-safe insert. Two reconciles can reach here concurrently against an
  // unseeded DB (e.g. two PRs merging at once, each after its own empty
  // select). Without the conflict guard the loser hits the `user` PK / unique
  // email constraint and throws, which would fail the whole reconcile — the
  // exact failure mode this helper exists to prevent. onConflictDoNothing
  // makes the loser a no-op; we then read back the row the winner inserted.
  const [row] = await db
    .insert(schema.users)
    .values({
      id: SYSTEM_USER_ID,
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, SYSTEM_USER_ID));
  // The re-read should surface the row the race winner inserted. If it doesn't,
  // the conflict was on the unique `email` for a row carrying a *different* id
  // (or a winner that rolled back) — the system user still doesn't exist. Fail
  // loudly instead of returning undefined: a silent return here would let the
  // caller's very next definition insert FK-fail on createdBy, which is exactly
  // the failure this helper exists to prevent.
  if (!raced) {
    throw new Error(
      `upsertSystemUser: system user ${SYSTEM_USER_ID} still missing after conflict re-read`,
    );
  }
  return raced;
}
