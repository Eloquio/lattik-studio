import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  MAX_LIMIT,
  parseJsonBody,
  requestStatusSchema,
  runStatusSchema,
} from "./api-validation";

function jsonRequest(body: unknown): Request {
  return new Request("http://local/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parseJsonBody", () => {
  const schema = z.object({
    a: z.string(),
    b: z.number().int().min(1),
  });

  it("returns parsed data for valid bodies", async () => {
    const result = await parseJsonBody(jsonRequest({ a: "hi", b: 2 }), schema);
    assert.ok(!(result instanceof Response));
    assert.deepStrictEqual(result, { a: "hi", b: 2 });
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const result = await parseJsonBody(jsonRequest("not-json"), schema);
    assert.ok(result instanceof Response);
    assert.strictEqual(result.status, 400);
    const body = (await result.json()) as { error: string };
    assert.match(body.error, /not valid JSON/);
  });

  it("returns 400 with issue details when validation fails", async () => {
    const result = await parseJsonBody(jsonRequest({ a: 3, b: 0 }), schema);
    assert.ok(result instanceof Response);
    assert.strictEqual(result.status, 400);
    const body = (await result.json()) as {
      error: string;
      issues: Array<{ path: string; message: string }>;
    };
    assert.strictEqual(body.error, "Invalid request body");
    assert.ok(Array.isArray(body.issues));
    // Issues should name the two failed paths (a, b) in any order.
    const paths = body.issues.map((i) => i.path).sort();
    assert.deepStrictEqual(paths, ["a", "b"]);
  });

  it("strips unknown fields by default (zod passthrough-free)", async () => {
    const result = await parseJsonBody(
      jsonRequest({ a: "hi", b: 2, extra: "ignored" }),
      schema,
    );
    assert.ok(!(result instanceof Response));
    assert.strictEqual((result as { extra?: unknown }).extra, undefined);
  });
});

describe("status enum schemas", () => {
  it("runStatusSchema accepts all canonical statuses", () => {
    for (const s of ["draft", "pending", "claimed", "done", "failed"]) {
      assert.ok(runStatusSchema.safeParse(s).success, `should accept ${s}`);
    }
  });

  it("runStatusSchema rejects arbitrary strings", () => {
    assert.strictEqual(runStatusSchema.safeParse("in_progress").success, false);
    assert.strictEqual(runStatusSchema.safeParse("").success, false);
  });

  it("requestStatusSchema accepts all canonical statuses", () => {
    for (const s of [
      "pending",
      "planning",
      "awaiting_approval",
      "approved",
      "done",
      "failed",
    ]) {
      assert.ok(requestStatusSchema.safeParse(s).success, `should accept ${s}`);
    }
  });
});

describe("MAX_LIMIT", () => {
  it("is a positive integer sentinel used across routes", () => {
    assert.ok(Number.isInteger(MAX_LIMIT) && MAX_LIMIT > 0);
  });
});
