import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseOpenParam,
  serializeOpenParam,
  toggleOpenRun,
} from "./open-run-state";

describe("parseOpenParam", () => {
  it("yields an empty set for a missing param", () => {
    assert.deepStrictEqual(parseOpenParam(null), new Set());
  });

  it("yields an empty set for an empty string", () => {
    assert.deepStrictEqual(parseOpenParam(""), new Set());
  });

  it("keeps a single id", () => {
    assert.deepStrictEqual(parseOpenParam("a"), new Set(["a"]));
  });

  it("clamps a legacy multi-id link to the first id", () => {
    // Backward-compat: older share links wrote `?open=a,b`. Accordion state
    // holds at most one, so restore only the first card.
    assert.deepStrictEqual(parseOpenParam("a,b,c"), new Set(["a"]));
  });

  it("ignores empty segments and keeps the first non-empty id", () => {
    assert.deepStrictEqual(parseOpenParam(",,a,b"), new Set(["a"]));
    assert.deepStrictEqual(parseOpenParam("a,"), new Set(["a"]));
  });
});

describe("toggleOpenRun", () => {
  it("opens a card from the closed state", () => {
    assert.deepStrictEqual(toggleOpenRun(new Set(), "a"), new Set(["a"]));
  });

  it("closes the card when it is already open", () => {
    assert.deepStrictEqual(toggleOpenRun(new Set(["a"]), "a"), new Set());
  });

  it("collapses the open card when a different one is opened (accordion)", () => {
    assert.deepStrictEqual(toggleOpenRun(new Set(["a"]), "b"), new Set(["b"]));
  });

  it("never holds more than one id", () => {
    assert.strictEqual(toggleOpenRun(new Set(["a"]), "b").size, 1);
  });
});

describe("serializeOpenParam", () => {
  it("returns null when nothing is open", () => {
    assert.strictEqual(serializeOpenParam(new Set()), null);
  });

  it("returns the id when one card is open", () => {
    assert.strictEqual(serializeOpenParam(new Set(["a"])), "a");
  });

  it("round-trips with parseOpenParam", () => {
    const open = toggleOpenRun(new Set(), "a");
    assert.deepStrictEqual(parseOpenParam(serializeOpenParam(open)), open);
  });
});
