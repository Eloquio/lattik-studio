import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_USER_EMAIL,
  SYSTEM_USER_ID,
  SYSTEM_USER_NAME,
  upsertSystemUser,
} from "./system-user";

type Row = Record<string, unknown>;

/**
 * Minimal fake of the drizzle query-builder chain `upsertSystemUser` uses:
 *   db.select().from(_).where(_)                            → resolves to rows
 *   db.insert(_).values(v).onConflictDoNothing().returning() → resolves to rows
 *
 * The first select resolves to `existing`; any later select (the raced re-read
 * after a swallowed conflict) resolves to `afterInsertSelect`. `insertReturns`
 * controls what the guarded insert returns — `[]` simulates losing the race to
 * a concurrent inserter. `calls` captures the inserted values, whether the
 * conflict guard ran, and how many selects happened.
 */
function fakeDb(opts: {
  existing?: Row[];
  insertReturns?: Row[];
  afterInsertSelect?: Row[];
}) {
  const existing = opts.existing ?? [];
  const calls = {
    inserted: null as Row | null,
    conflictGuarded: false,
    selects: 0,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          calls.selects += 1;
          const rows =
            calls.selects === 1 ? existing : (opts.afterInsertSelect ?? []);
          return Promise.resolve(rows);
        },
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        calls.inserted = v;
        return {
          onConflictDoNothing: () => {
            calls.conflictGuarded = true;
            return { returning: () => Promise.resolve(opts.insertReturns ?? [v]) };
          },
        };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof upsertSystemUser>[0], calls };
}

describe("upsertSystemUser", () => {
  it("inserts the pinned system user when the row is missing", async () => {
    const { db, calls } = fakeDb({ existing: [] });
    const row = await upsertSystemUser(db);
    assert.equal(calls.inserted?.id, SYSTEM_USER_ID);
    assert.equal(calls.inserted?.email, SYSTEM_USER_EMAIL);
    assert.equal(calls.inserted?.name, SYSTEM_USER_NAME);
    assert.ok(
      calls.conflictGuarded,
      "insert must be guarded with onConflictDoNothing",
    );
    assert.equal((row as Row).id, SYSTEM_USER_ID);
  });

  it("is a no-op when the system user already exists (idempotent)", async () => {
    const existing: Row = { id: SYSTEM_USER_ID, email: SYSTEM_USER_EMAIL };
    const { db, calls } = fakeDb({ existing: [existing] });
    const row = await upsertSystemUser(db);
    assert.equal(calls.inserted, null); // never inserts a second time
    assert.equal((row as Row).id, SYSTEM_USER_ID);
  });

  it("re-reads the row when a concurrent insert wins the race", async () => {
    const raced: Row = { id: SYSTEM_USER_ID, email: SYSTEM_USER_EMAIL };
    // existing empty → we attempt the insert, but the guard swallows the
    // conflict (insertReturns: []) because a concurrent reconcile inserted
    // first; the re-read then surfaces that row instead of throwing.
    const { db, calls } = fakeDb({
      existing: [],
      insertReturns: [],
      afterInsertSelect: [raced],
    });
    const row = await upsertSystemUser(db);
    assert.ok(
      calls.conflictGuarded,
      "insert must be guarded with onConflictDoNothing",
    );
    assert.equal(calls.selects, 2, "must re-read after losing the race");
    assert.equal((row as Row).id, SYSTEM_USER_ID);
  });

  it("throws when the row is still missing after the conflict re-read", async () => {
    // insert swallowed a conflict (insertReturns: []) but the re-read finds no
    // row — e.g. the conflict was on the unique email for a different id. The
    // system user still doesn't exist, so this must fail loudly rather than
    // return undefined and let the caller's next FK insert blow up silently.
    const { db, calls } = fakeDb({
      existing: [],
      insertReturns: [],
      afterInsertSelect: [],
    });
    await assert.rejects(() => upsertSystemUser(db), /still missing/);
    assert.equal(calls.selects, 2, "must attempt the re-read before throwing");
  });
});
