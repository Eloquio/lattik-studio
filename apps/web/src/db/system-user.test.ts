import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_USER_ID, upsertSystemUser } from "./system-user";

type Row = Record<string, unknown>;

/**
 * Minimal fake of the drizzle query-builder chain `upsertSystemUser` uses:
 *   db.select().from(_).where(_)            → resolves to existing rows
 *   db.insert(_).values(v).returning()      → resolves to [v]
 * `inserted` captures the values passed to insert (null if insert never ran).
 */
function fakeDb(existing: Row[]) {
  const calls: { inserted: Row | null } = { inserted: null };
  const db = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(existing) }),
    }),
    insert: () => ({
      values: (v: Row) => {
        calls.inserted = v;
        return { returning: () => Promise.resolve([v]) };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof upsertSystemUser>[0], calls };
}

describe("upsertSystemUser", () => {
  it("inserts the pinned system user when the row is missing", async () => {
    const { db, calls } = fakeDb([]);
    const row = await upsertSystemUser(db);
    assert.equal(calls.inserted?.id, SYSTEM_USER_ID);
    assert.equal(calls.inserted?.email, "system@lattik.local");
    assert.equal((row as Row).id, SYSTEM_USER_ID);
  });

  it("is a no-op when the system user already exists (idempotent)", async () => {
    const existing: Row = { id: SYSTEM_USER_ID, email: "system@lattik.local" };
    const { db, calls } = fakeDb([existing]);
    const row = await upsertSystemUser(db);
    assert.equal(calls.inserted, null); // never inserts a second time
    assert.equal((row as Row).id, SYSTEM_USER_ID);
  });
});
