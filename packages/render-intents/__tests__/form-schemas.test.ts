import { describe, it, expect } from "vitest";
import {
  loggerTableFormInitialStateSchema,
  entityFormInitialStateSchema,
} from "../src/index.js";

/**
 * These schemas are the LLM-facing contract for `renderXxxForm` tool input.
 * The form-rendering bug they fix: when the schema permitted any key
 * shape (e.g. `Record<string, unknown>`), the LLM picked names like
 * `columns` for what the form actually reads as `user_columns`. The
 * adapter then silently fell back to an empty form. With these typed
 * schemas wired into the tool inputs, the LLM sees exactly what's
 * accepted and the SDK rejects the wrong shape before execute.
 */

describe("loggerTableFormInitialStateSchema", () => {
  it("accepts user-defined columns under `user_columns`", () => {
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      name: "ingest.impressions",
      user_columns: [
        { name: "impression_id", type: "string" },
        { name: "user_id", type: "int64" },
        { name: "ad_slot", type: "string" },
        { name: "campaign_id", type: "int64" },
        { name: "timestamp", type: "timestamp" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.user_columns).toHaveLength(5);
      expect(parsed.data.user_columns?.[0]?.name).toBe("impression_id");
    }
  });

  it("rejects the wrong-name `columns` key (was silently stripped before strict mode)", () => {
    // The whole-form bug we shipped this schema to catch: the LLM put
    // the column array under `columns` instead of `user_columns`.
    // With `.strict()` zod throws on unknown keys, the AI SDK fails
    // the tool call, the agent loop reports the error back to the
    // model, and the model self-corrects on the next turn. Without
    // strict mode, zod silently stripped `columns`, the tool succeeded
    // with an empty `user_columns`, and the canvas rendered with no
    // custom columns — the regression user-visible failure.
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      columns: [{ name: "impression_id", type: "string" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects `dedup` (was the wrong key name for `dedup_window`)", () => {
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      dedup: "1h",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects columns missing required `type`", () => {
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      user_columns: [{ name: "impression_id" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys inside nested column items (nested strictness)", () => {
    // Belt-and-suspenders: the column item's strict() catches an LLM
    // that puts e.g. `kind` instead of `type` on the item itself, even
    // though `name` and `type` are present on a sibling column. Without
    // nested strict(), zod silently strips `kind` and the canvas
    // happily renders an underspecified column.
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      user_columns: [
        {
          name: "impression_id",
          type: "string",
          // bogus key — should fail the parse
          extra_metadata: { foo: "bar" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects columns with type outside the supported enum", () => {
    const parsed = loggerTableFormInitialStateSchema.safeParse({
      user_columns: [{ name: "x", type: "uuid" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an empty initial state — the no-pre-fill path", () => {
    expect(
      loggerTableFormInitialStateSchema.safeParse({}).success,
    ).toBe(true);
  });
});

describe("entityFormInitialStateSchema", () => {
  it("accepts canonical entity fields", () => {
    const parsed = entityFormInitialStateSchema.safeParse({
      name: "user",
      description: "Application users",
      id_field: "user_id",
      id_type: "int64",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an id_type outside { int64, string }", () => {
    const parsed = entityFormInitialStateSchema.safeParse({
      id_type: "uuid",
    });
    expect(parsed.success).toBe(false);
  });
});
