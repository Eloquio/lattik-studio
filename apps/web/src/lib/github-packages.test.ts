import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchEmbeddedSchema,
  packTarball,
  packageUrlFor,
  publishLoggerSdk,
  readPackageJsonFromTarball,
} from "./github-packages";
import { renderLoggerPackage, schemaSignature } from "./logger-sdk-generator";
import type { LoggerTable } from "@/extensions/data-architect/schema";

const table: LoggerTable = {
  name: "ingest.impressions",
  description: "Ad impressions",
  retention: "30d",
  dedup_window: "1h",
  columns: [
    { name: "user_id", type: "string" },
    { name: "count", type: "int64" },
  ],
};

describe("packTarball + readPackageJsonFromTarball round-trip", () => {
  it("packs a gzipped npm tarball whose package/package.json is recoverable", async () => {
    const files = renderLoggerPackage(table, {
      version: "1.0.0",
      scope: "@eloquio",
    });
    const buf = await packTarball(files);
    assert.ok(buf.length > 0);
    // gzip magic bytes — confirms it's actually gzipped.
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);

    const pkg = await readPackageJsonFromTarball(buf);
    assert.equal(pkg?.name, "@eloquio/logger-ingest-impressions");
    assert.equal(pkg?.version, "1.0.0");
    // The embedded lattikSchema must round-trip so the next publish can diff
    // against it (this is the registry-agnostic source of truth for the diff).
    assert.deepEqual(pkg?.lattikSchema, schemaSignature(table));
  });
});

describe("packageUrlFor", () => {
  it("derives the org from the scope (GitHub org URLs are case-insensitive)", () => {
    assert.equal(
      packageUrlFor("@eloquio/logger-ingest-impressions"),
      "https://github.com/orgs/eloquio/packages/npm/package/logger-ingest-impressions",
    );
  });
});

describe("publishLoggerSdk (publishing disabled)", () => {
  it("is a no-op recording the would-be package, with no network call", async () => {
    // GITHUB_PACKAGES_PUBLISH_ENABLED is unset in the test env, so this must
    // short-circuit before touching the registry — mirrors FIREHOSE_ENABLED.
    const result = await publishLoggerSdk(table);
    assert.equal(result.action, "skipped");
    assert.equal(result.version, "0.0.0-dev");
    assert.equal(result.packageName, "@eloquio/logger-ingest-impressions");
    assert.equal(result.registryUrl, "https://npm.pkg.github.com");
    // packageUrl is the one result field the workflow runner forwards that no
    // other test asserts — pin it so the detail shape the UI renders is covered.
    assert.equal(
      result.packageUrl,
      "https://github.com/orgs/eloquio/packages/npm/package/logger-ingest-impressions",
    );
  });
});

describe("fetchEmbeddedSchema HTTP handling", () => {
  it("returns null on 404 (tarball absent → schema unknown, not a hard failure)", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
    assert.equal(await fetchEmbeddedSchema("https://example.test/pkg.tgz"), null);
  });

  it("throws on a non-404 failure rather than silently churning the version", async (t) => {
    // A 401/403/5xx must be fatal: degrading to null here would read as
    // "schema unknown" and spuriously bump the version on a transient/auth
    // error — exactly what fetchPublishedState guards against for the packument.
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    await assert.rejects(
      () => fetchEmbeddedSchema("https://example.test/pkg.tgz"),
      /HTTP 503/,
    );
  });

  it("withholds the auth token from a tarball host that isn't the registry", async (t) => {
    // dist.tarball comes from the registry's packument response. The PAT is a
    // long-lived write:packages credential, so it must NOT be forwarded to a
    // host derived from that response unless it matches the registry host —
    // otherwise a compromised/misconfigured registry could exfiltrate it.
    const seen: { url: string; auth: string | null }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      return new Response(null, { status: 404 });
    });

    await fetchEmbeddedSchema("https://evil.example/pkg.tgz");
    // Same host as the default REGISTRY (npm.pkg.github.com) → auth allowed.
    await fetchEmbeddedSchema("https://npm.pkg.github.com/@eloquio/x/-/x-1.0.0.tgz");

    assert.equal(seen[0]!.auth, null, "no token to a foreign tarball host");
    assert.ok(seen[1]!.auth?.startsWith("Bearer "), "token sent to the registry host");
  });
});
