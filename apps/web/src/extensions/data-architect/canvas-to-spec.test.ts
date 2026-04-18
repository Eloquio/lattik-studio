import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canvasStateToSpec } from "./canvas-to-spec";

/**
 * Build a minimal canvas state wrapper the way `<Renderer>` produces one —
 * tools read form state from `canvasState.state`, so these tests mirror that
 * structure.
 */
function canvas(state: Record<string, unknown>) {
  return { state };
}

describe("canvasStateToSpec(lattik_table)", () => {
  it("converts key_mapping array → record and strips strategy-incompatible fields", () => {
    const spec = canvasStateToSpec("lattik_table", canvas({
      name: "user_stats",
      description: "per-user cumulative counters",
      primary_key: [{ _key: "pk1", column: "user_id", entity: "user" }],
      column_families: [
        {
          _key: "cf1",
          name: "signups",
          source: "ingest.signups",
          key_mapping: [
            { _key: "km1", pk_column: "user_id", source_column: "user_id" },
          ],
          columns: [
            {
              _key: "c1",
              name: "signup_count",
              strategy: "lifetime_window",
              agg: "count()",
              // Should be dropped by the prepend_list stripper:
              expr: "ignore me",
              max_length: 99,
            },
          ],
        },
      ],
    })) as {
      name: string;
      column_families: Array<{
        key_mapping: Record<string, string>;
        columns: Array<Record<string, unknown>>;
      }>;
      backfill?: unknown;
    };

    assert.strictEqual(spec.name, "user_stats");
    assert.deepStrictEqual(spec.column_families[0].key_mapping, {
      user_id: "user_id",
    });
    const col = spec.column_families[0].columns[0];
    assert.strictEqual(col.strategy, "lifetime_window");
    assert.strictEqual(col.agg, "count()");
    assert.strictEqual(col.expr, undefined, "lifetime_window col should not carry `expr`");
    assert.strictEqual(col.max_length, undefined, "lifetime_window col should not carry `max_length`");
    assert.strictEqual(spec.backfill, undefined, "default backfill should be omitted");
  });

  it("omits the backfill block when the user left defaults alone", () => {
    const spec = canvasStateToSpec("lattik_table", canvas({
      name: "t",
      description: "",
      primary_key: [],
      column_families: [],
      backfill: { lookback: "30d", parallelism: 1 },
    })) as { backfill?: unknown };
    assert.strictEqual(spec.backfill, undefined);
  });

  it("includes backfill when the user customized lookback", () => {
    const spec = canvasStateToSpec("lattik_table", canvas({
      name: "t",
      description: "",
      primary_key: [],
      column_families: [],
      backfill: { lookback: "90d", parallelism: 1 },
    })) as { backfill?: { lookback?: string; parallelism?: number } };
    assert.deepStrictEqual(spec.backfill, { lookback: "90d" });
  });

  it("includes backfill when the user customized parallelism", () => {
    const spec = canvasStateToSpec("lattik_table", canvas({
      name: "t",
      description: "",
      primary_key: [],
      column_families: [],
      backfill: { lookback: "30d", parallelism: 4 },
    })) as { backfill?: { lookback?: string; parallelism?: number } };
    assert.deepStrictEqual(spec.backfill, { parallelism: 4 });
  });

  it("strips _key fields recursively", () => {
    const spec = canvasStateToSpec("lattik_table", canvas({
      name: "t",
      description: "",
      primary_key: [{ _key: "a", column: "id", entity: "user" }],
      column_families: [],
    })) as { primary_key: Array<Record<string, unknown>> };
    assert.strictEqual(spec.primary_key[0]._key, undefined);
    assert.strictEqual(spec.primary_key[0].column, "id");
  });
});

describe("canvasStateToSpec(logger_table)", () => {
  it("renames user_columns → columns and passes classification through, dropping false/undefined flags", () => {
    const spec = canvasStateToSpec("logger_table", canvas({
      name: "events.signups",
      description: "raw signups",
      retention: "30d",
      dedup_window: "1h",
      user_columns: [
        { _key: "c1", name: "email", type: "string", classification: { pii: true, phi: false } },
        { _key: "c2", name: "ssn", type: "string", classification: { pii: true, phi: true } },
        { _key: "c3", name: "country", type: "string", classification: { pii: false } },
        { _key: "c4", name: "amount", type: "int64" },
      ],
    })) as {
      columns: Array<{ name: string; type: string; classification?: Record<string, boolean>; tags?: string[] }>;
    };

    assert.strictEqual(spec.columns.length, 4);
    assert.deepStrictEqual(spec.columns[0].classification, { pii: true });
    assert.deepStrictEqual(spec.columns[1].classification, { pii: true, phi: true });
    assert.strictEqual(spec.columns[2].classification, undefined, "no classification when all flags are false");
    assert.strictEqual(spec.columns[3].classification, undefined, "omitted classification stays omitted");
  });

  it("preserves freeform tags alongside classification", () => {
    const spec = canvasStateToSpec("logger_table", canvas({
      name: "events.signups",
      description: "",
      retention: "30d",
      dedup_window: "1h",
      user_columns: [
        {
          _key: "c1",
          name: "user_id",
          type: "string",
          classification: { pii: true },
          tags: ["high-cardinality"],
        },
      ],
    })) as {
      columns: Array<{ classification?: Record<string, boolean>; tags?: string[] }>;
    };

    assert.deepStrictEqual(spec.columns[0].classification, { pii: true });
    assert.deepStrictEqual(spec.columns[0].tags, ["high-cardinality"]);
  });
});
