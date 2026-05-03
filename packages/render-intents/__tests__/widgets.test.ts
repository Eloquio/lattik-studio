import { describe, it, expect } from "vitest";
import {
  isWidget,
  messageWidgetSchema,
  type MessageWidget,
  type ReviewSuggestionsWidget,
} from "../src/index.js";

describe("isWidget", () => {
  it("narrows to the matching kind", () => {
    const widget: MessageWidget = {
      kind: "review-suggestions",
      data: {
        definitionKind: "logger_table",
        suggestions: [
          {
            id: "missing_desc",
            title: "Add a description",
            description: "Static check requires `description` to be set.",
            actions: [{ path: "/description", value: "User events" }],
          },
        ],
      },
    };
    if (isWidget(widget, "review-suggestions")) {
      const sug: ReviewSuggestionsWidget["data"]["suggestions"] =
        widget.data.suggestions;
      expect(sug[0]?.id).toBe("missing_desc");
    } else {
      throw new Error("expected review-suggestions");
    }
  });
});

describe("messageWidgetSchema", () => {
  it("accepts a well-formed review-suggestions widget", () => {
    const result = messageWidgetSchema.safeParse({
      kind: "review-suggestions",
      data: {
        definitionKind: "logger_table",
        suggestions: [
          {
            id: "missing_desc",
            title: "Add a description",
            description: "Required by static check.",
            actions: [{ path: "/description", value: "User events" }],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty suggestions array (clean review)", () => {
    const result = messageWidgetSchema.safeParse({
      kind: "review-suggestions",
      data: { definitionKind: "logger_table", suggestions: [] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a suggestion with no actions (must have ≥1)", () => {
    const result = messageWidgetSchema.safeParse({
      kind: "review-suggestions",
      data: {
        definitionKind: "logger_table",
        suggestions: [
          { id: "x", title: "x", description: "x", actions: [] },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown widget kinds", () => {
    const result = messageWidgetSchema.safeParse({
      kind: "totally-made-up",
      data: {},
    });
    expect(result.success).toBe(false);
  });
});
