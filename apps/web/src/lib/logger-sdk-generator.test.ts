import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  packageNameFor,
  renderLoggerPackage,
  schemaSignature,
} from "./logger-sdk-generator";
import type { LoggerTable } from "@/extensions/data-architect/schema";

const table: LoggerTable = {
  name: "ingest.impressions",
  description: "Ad impressions",
  retention: "30d",
  dedup_window: "1h",
  columns: [
    { name: "user_id", type: "string", description: "the user" },
    { name: "count", type: "int64" },
    { name: "is_test", type: "boolean", tags: ["qa"] },
  ],
};

function fileMap(files: { path: string; content: string }[]) {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("packageNameFor", () => {
  it("maps a dotted table name to a scoped, hyphenated package", () => {
    assert.equal(
      packageNameFor("ingest.impressions", "@eloquio"),
      "@eloquio/logger-ingest-impressions",
    );
  });
  it("collapses underscores and other separators to single hyphens", () => {
    assert.equal(
      packageNameFor("events.click_events", "@eloquio"),
      "@eloquio/logger-events-click-events",
    );
  });
});

describe("schemaSignature", () => {
  it("returns name+type only, sorted by name", () => {
    assert.deepEqual(schemaSignature(table), [
      { name: "count", type: "int64" },
      { name: "is_test", type: "boolean" },
      { name: "user_id", type: "string" },
    ]);
  });
});

describe("renderLoggerPackage", () => {
  const files = renderLoggerPackage(table, { version: "1.2.3", scope: "@eloquio" });
  const map = fileMap(files);

  it("emits package.json, index.js, index.d.ts, README.md", () => {
    assert.deepEqual(
      [...map.keys()].sort(),
      ["README.md", "index.d.ts", "index.js", "package.json"],
    );
  });

  it("package.json is a valid ESM manifest with the right fields", () => {
    const pkg = JSON.parse(map.get("package.json")!);
    assert.equal(pkg.name, "@eloquio/logger-ingest-impressions");
    assert.equal(pkg.version, "1.2.3");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.exports["."].import, "./index.js");
    assert.equal(pkg.exports["."].types, "./index.d.ts");
    assert.equal(pkg.publishConfig.registry, "https://npm.pkg.github.com");
    assert.ok(pkg.peerDependencies["@aws-sdk/client-firehose"]);
    // Embedded signature must equal the schema signature for diff-based bumps.
    assert.deepEqual(pkg.lattikSchema, schemaSignature(table));
  });

  it("index.d.ts declares the typed interface, stream const, and class", () => {
    const dts = map.get("index.d.ts")!;
    assert.match(dts, /export interface IngestImpressionsEvent/);
    assert.match(dts, /user_id: string;/);
    assert.match(dts, /count: number;/);
    assert.match(dts, /is_test: boolean;/);
    assert.match(dts, /export declare const STREAM_NAME: string;/);
    assert.match(dts, /export declare class IngestImpressionsLogger/);
  });

  it("index.js carries the runtime class and the resolved stream name", () => {
    const js = map.get("index.js")!;
    assert.match(js, /export const STREAM_NAME = "lattik-ingest\.impressions";/);
    assert.match(js, /export class IngestImpressionsLogger/);
    assert.match(js, /PutRecordBatchCommand/);
  });
});
