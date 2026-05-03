import { describe, it, expect } from "vitest";
import {
  isIntent,
  renderIntentSchema,
  intentActionSchema,
  type RenderIntent,
  type DagOverviewIntent,
} from "../src/index.js";

describe("isIntent", () => {
  it("narrows to the matching kind", () => {
    const intent: RenderIntent = {
      kind: "dag-overview",
      surface: "main",
      data: { dags: [], totalEntries: 0 },
    };
    if (isIntent(intent, "dag-overview")) {
      // Type-narrow check — `data.dags` only exists on DagOverviewIntent.
      const dags: DagOverviewIntent["data"]["dags"] = intent.data.dags;
      expect(dags).toEqual([]);
    } else {
      throw new Error("expected dag-overview");
    }
  });

  it("returns false for non-matching kinds", () => {
    const intent: RenderIntent = {
      kind: "sql-editor",
      surface: "editor",
      data: { sql: "SELECT 1" },
    };
    expect(isIntent(intent, "dag-overview")).toBe(false);
  });
});

describe("renderIntentSchema", () => {
  it("accepts a well-formed dag-overview intent", () => {
    const result = renderIntentSchema.safeParse({
      kind: "dag-overview",
      surface: "main",
      data: {
        dags: [
          {
            dagId: "lattik__user_events",
            description: "User events pipeline",
            isPaused: false,
            isActive: true,
            schedule: "@hourly",
            tags: ["lattik"],
            nextRun: "2026-05-03T00:00:00Z",
          },
        ],
        totalEntries: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wrong surface for the kind", () => {
    const result = renderIntentSchema.safeParse({
      kind: "dag-overview",
      surface: "detail",
      data: { dags: [], totalEntries: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown intent kinds", () => {
    const result = renderIntentSchema.safeParse({
      kind: "totally-made-up",
      surface: "main",
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = renderIntentSchema.safeParse({
      kind: "dag-overview",
      surface: "main",
      data: { dags: [] }, // missing totalEntries
    });
    expect(result.success).toBe(false);
  });
});

describe("intentActionSchema", () => {
  it("accepts a well-formed dag-overview action", () => {
    const result = intentActionSchema.safeParse({
      intentKind: "dag-overview",
      surface: "main",
      action: { type: "select-row", dagId: "lattik__user_events" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an action variant that doesn't belong to the intent kind", () => {
    const result = intentActionSchema.safeParse({
      intentKind: "dag-overview",
      surface: "main",
      action: { type: "select-task", taskId: "build" }, // dag-run-detail action
    });
    expect(result.success).toBe(false);
  });

  it("rejects a wrong surface for the intent kind", () => {
    const result = intentActionSchema.safeParse({
      intentKind: "dag-overview",
      surface: "detail",
      action: { type: "select-row", dagId: "x" },
    });
    expect(result.success).toBe(false);
  });
});
