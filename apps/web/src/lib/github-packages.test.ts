import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
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
  });
});
