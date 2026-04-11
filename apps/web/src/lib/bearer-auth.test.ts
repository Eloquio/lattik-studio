import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { requireBearer, requireLattikAuth, requireTaskAuth } from "./bearer-auth";

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

describe("requireLattikAuth / requireTaskAuth", () => {
  it("wire to LATTIK_API_TOKEN and TASK_AGENT_SECRET respectively", () => {
    process.env.LATTIK_API_TOKEN = "lattik-secret";
    process.env.TASK_AGENT_SECRET = "task-secret";
    try {
      assert.strictEqual(
        requireLattikAuth(reqWith("Bearer lattik-secret")),
        null,
      );
      assert.strictEqual(
        requireTaskAuth(reqWith("Bearer task-secret")),
        null,
      );
      // Cross-use fails (wrong env var for each).
      assert.ok(
        requireLattikAuth(reqWith("Bearer task-secret")) instanceof Response,
      );
      assert.ok(
        requireTaskAuth(reqWith("Bearer lattik-secret")) instanceof Response,
      );
    } finally {
      delete process.env.LATTIK_API_TOKEN;
      delete process.env.TASK_AGENT_SECRET;
    }
  });
});
