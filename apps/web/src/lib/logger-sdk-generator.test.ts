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
    // `repository` MUST be the git-object form, not a bare string. We publish
    // via libnpmpublish (no `npm publish` CLI normalization), and GitHub
    // Packages rejects a publish whose repository host it can't parse from a
    // string field ("invalid repo host ''").
    assert.deepEqual(pkg.repository, {
      type: "git",
      url: "git+https://github.com/Eloquio/lattik-studio.git",
    });
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

  it("escapes */ in free-text docs so the JSDoc comment can't terminate early", () => {
    // description + tags are arbitrary free text (validateDescription allows up
    // to 500 chars of any content). A raw "*/" would close the generated JSDoc
    // block comment early and emit invalid TypeScript into the published .d.ts.
    const evil: LoggerTable = {
      ...table,
      columns: [
        { name: "x", type: "string", description: "danger */ leak", tags: ["a*/b"] },
      ],
    };
    const dts = fileMap(
      renderLoggerPackage(evil, { version: "1.0.0", scope: "@eloquio" }),
    ).get("index.d.ts")!;
    // The raw star-slash from description + tags is escaped to "*\/" (a
    // backslash breaks the two-char terminator), and the doc comment closes
    // cleanly right before the property declaration.
    assert.ok(
      dts.includes("/** danger *\\/ leak — tags: a*\\/b */\n  x: string;"),
      `comment not escaped as expected; got:\n${dts}`,
    );
    // The verbatim, un-escaped form must NOT appear — that would terminate the
    // block comment early and emit invalid TypeScript.
    assert.ok(!dts.includes("danger */ leak"));
  });

  it("index.js carries the runtime class and the resolved stream name", () => {
    const js = map.get("index.js")!;
    assert.match(js, /export const STREAM_NAME = "lattik-ingest\.impressions";/);
    assert.match(js, /export class IngestImpressionsLogger/);
    assert.match(js, /PutRecordBatchCommand/);
  });

  it("README .npmrc instructions track the package scope, not a literal", () => {
    // README is generated from the package name, so a non-default scope must
    // produce matching .npmrc install instructions — otherwise consumers are
    // told to configure the wrong @scope:registry and `pnpm add` won't resolve.
    assert.match(map.get("README.md")!, /@eloquio:registry=/);

    const scoped = fileMap(
      renderLoggerPackage(table, { version: "1.2.3", scope: "@acme" }),
    );
    const readme = scoped.get("README.md")!;
    assert.match(readme, /@acme:registry=https:\/\/npm\.pkg\.github\.com/);
    assert.match(readme, /under the `@acme` scope/);
    assert.doesNotMatch(readme, /@eloquio:registry=/);
  });

  it("threads a registry override into publishConfig and both README .npmrc lines", () => {
    // A GITHUB_PACKAGES_REGISTRY override (e.g. a GitHub Enterprise package
    // registry) must reach the generated package: publishConfig.registry, the
    // @scope:registry line, AND the //host/:_authToken line all key on it.
    // Otherwise the package self-describes a host it wasn't published to and
    // consumers following the README configure the wrong registry.
    const ghe = "https://npm.pkg.github.example.com";
    const files = fileMap(
      renderLoggerPackage(table, {
        version: "1.0.0",
        scope: "@eloquio",
        registry: ghe,
      }),
    );
    const pkg = JSON.parse(files.get("package.json")!);
    assert.equal(pkg.publishConfig.registry, ghe);

    const readme = files.get("README.md")!;
    assert.match(readme, /@eloquio:registry=https:\/\/npm\.pkg\.github\.example\.com/);
    // The auth line keys on the host (no protocol), derived from the registry.
    assert.match(readme, /\/\/npm\.pkg\.github\.example\.com\/:_authToken=/);
    // The public default host must NOT leak into the auth line when overridden.
    assert.doesNotMatch(readme, /\/\/npm\.pkg\.github\.com\/:_authToken/);
  });

  it("defaults publishConfig + README to the public GitHub Packages host", () => {
    // No registry passed → both must fall back to npm.pkg.github.com so the
    // common path (no override) is unchanged.
    assert.equal(
      JSON.parse(map.get("package.json")!).publishConfig.registry,
      "https://npm.pkg.github.com",
    );
    assert.match(map.get("README.md")!, /\/\/npm\.pkg\.github\.com\/:_authToken=/);
  });
});
