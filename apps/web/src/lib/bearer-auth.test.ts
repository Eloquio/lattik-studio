import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { requireBearer, requireLattikAuth } from "./bearer-auth";

function reqWith(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("http://local/test", { headers });
}

const ENV_KEY = "TEST_BEARER_SECRET_FOR_UNITS";

describe("requireBearer", () => {
  beforeEach(() => {
    process.env[ENV_KEY] = "the-correct-secret";
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns null when the Authorization header matches", () => {
    const result = requireBearer(
      reqWith("Bearer the-correct-secret"),
      ENV_KEY,
    );
    assert.strictEqual(result, null);
  });

  it("returns 401 when the header is wrong", async () => {
    const result = requireBearer(reqWith("Bearer wrong"), ENV_KEY);
    assert.ok(result instanceof Response);
    assert.strictEqual(result.status, 401);
  });

  it("returns 401 when the header is missing", () => {
    const result = requireBearer(reqWith(null), ENV_KEY);
    assert.ok(result instanceof Response);
    assert.strictEqual((result as Response).status, 401);
  });

  it("returns 401 when the header has no Bearer prefix", () => {
    const result = requireBearer(
      reqWith("the-correct-secret"),
      ENV_KEY,
    );
    assert.ok(result instanceof Response);
    assert.strictEqual((result as Response).status, 401);
  });

  it("returns 500 when the env var is unset (misconfiguration)", () => {
    delete process.env[ENV_KEY];
    const result = requireBearer(
      reqWith("Bearer anything"),
      ENV_KEY,
    );
    assert.ok(result instanceof Response);
    assert.strictEqual((result as Response).status, 500);
  });
});

describe("requireLattikAuth", () => {
  it("wires to LATTIK_API_TOKEN", () => {
    process.env.LATTIK_API_TOKEN = "lattik-secret";
    try {
      assert.strictEqual(
        requireLattikAuth(reqWith("Bearer lattik-secret")),
        null,
      );
      assert.ok(
        requireLattikAuth(reqWith("Bearer wrong")) instanceof Response,
      );
    } finally {
      delete process.env.LATTIK_API_TOKEN;
    }
  });
});
