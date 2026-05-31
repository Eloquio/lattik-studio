import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeVersionBump,
  decidePublishAction,
  diffBump,
  sigsEqual,
} from "./logger-sdk-version";
import type { ColumnSig } from "./logger-sdk-generator";

const a: ColumnSig = { name: "a", type: "string" };
const b: ColumnSig = { name: "b", type: "int64" };
const aRetyped: ColumnSig = { name: "a", type: "int64" };
const aPii: ColumnSig = { name: "a", type: "string", classification: "pii" };

describe("sigsEqual", () => {
  it("is true regardless of order", () => {
    assert.equal(sigsEqual([a, b], [b, a]), true);
  });
  it("is false on length / type / name difference", () => {
    assert.equal(sigsEqual([a], [a, b]), false);
    assert.equal(sigsEqual([a], [aRetyped]), false);
    assert.equal(sigsEqual([a], [b]), false);
  });
  it("is false when only the classification differs", () => {
    assert.equal(sigsEqual([a], [aPii]), false);
  });
});

describe("diffBump", () => {
  it("patch when signature is identical", () => {
    assert.equal(diffBump([a, b], [b, a]), "patch");
  });
  it("minor when a column is added", () => {
    assert.equal(diffBump([a], [a, b]), "minor");
  });
  it("major when a column is removed", () => {
    assert.equal(diffBump([a, b], [a]), "major");
  });
  it("major when a column is retyped", () => {
    assert.equal(diffBump([a], [aRetyped]), "major");
  });
  it("major when a column is renamed (removed + added → removal wins)", () => {
    assert.equal(diffBump([a], [b]), "major");
  });
  it("patch when only classification changes (name+type unchanged)", () => {
    assert.equal(diffBump([a], [aPii]), "patch");
  });
});

describe("computeVersionBump", () => {
  it("patch bump", () => {
    assert.equal(computeVersionBump([a], [a], "1.2.3"), "1.2.4");
  });
  it("minor bump resets patch", () => {
    assert.equal(computeVersionBump([a], [a, b], "1.2.3"), "1.3.0");
  });
  it("major bump resets minor + patch", () => {
    assert.equal(computeVersionBump([a, b], [a], "1.2.3"), "2.0.0");
    assert.equal(computeVersionBump([a], [aRetyped], "4.7.9"), "5.0.0");
  });
  it("falls back to 1.0.0 for an unparseable previous version", () => {
    assert.equal(computeVersionBump([a], [a, b], "not-a-version"), "1.0.0");
  });
  it("discards prerelease metadata on the previous version", () => {
    assert.equal(computeVersionBump([a], [a, b], "1.2.3-rc.1"), "1.3.0");
  });
});

describe("decidePublishAction", () => {
  it("creates at 1.0.0 when nothing is published", () => {
    assert.deepEqual(
      decidePublishAction({
        latestVersion: null,
        prevSchema: null,
        nextSchema: [a],
      }),
      { action: "created", version: "1.0.0" },
    );
  });

  it("is a no-op when the schema is unchanged vs latest", () => {
    assert.deepEqual(
      decidePublishAction({
        latestVersion: "2.3.1",
        prevSchema: [a, b],
        nextSchema: [b, a],
      }),
      { action: "unchanged", version: "2.3.1" },
    );
  });

  it("minor-bumps an additive change", () => {
    assert.deepEqual(
      decidePublishAction({
        latestVersion: "2.3.1",
        prevSchema: [a],
        nextSchema: [a, b],
      }),
      { action: "published", version: "2.4.0" },
    );
  });

  it("major-bumps a breaking change", () => {
    assert.deepEqual(
      decidePublishAction({
        latestVersion: "2.3.1",
        prevSchema: [a, b],
        nextSchema: [a],
      }),
      { action: "published", version: "3.0.0" },
    );
  });

  it("patch-bumps a classification-only change (compliance reclassification)", () => {
    assert.deepEqual(
      decidePublishAction({
        latestVersion: "2.3.1",
        prevSchema: [a],
        nextSchema: [aPii],
      }),
      { action: "published", version: "2.3.2" },
    );
  });

  it("treats unknown prior schema as a change (can't prove unchanged)", () => {
    // Older package with no embedded lattikSchema → prevSchema null. Every
    // current column reads as added → minor bump rather than a skipped no-op.
    assert.deepEqual(
      decidePublishAction({
        latestVersion: "1.4.0",
        prevSchema: null,
        nextSchema: [a, b],
      }),
      { action: "published", version: "1.5.0" },
    );
  });
});
