import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { hashSecret } from "./worker-tokens";

describe("hashSecret", () => {
  it("returns a deterministic sha256 hex digest of the secret", () => {
    const secret = "abc123";
    const expected = createHash("sha256").update(secret).digest("hex");
    assert.strictEqual(hashSecret(secret), expected);
  });

  it("produces different hashes for different secrets", () => {
    assert.notStrictEqual(hashSecret("a"), hashSecret("b"));
  });

  it("is stable across calls", () => {
    assert.strictEqual(hashSecret("same"), hashSecret("same"));
  });
});
