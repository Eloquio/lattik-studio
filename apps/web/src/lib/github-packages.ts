import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publish } from "libnpmpublish";
import npmFetch from "npm-registry-fetch";
import * as tar from "tar";

import type { LoggerTable } from "@/extensions/data-architect/schema";
import {
  type ColumnSig,
  type PackageFile,
  packageNameFor,
  renderLoggerPackage,
  schemaSignature,
} from "@/lib/logger-sdk-generator";
import { decidePublishAction } from "@/lib/logger-sdk-version";

/**
 * Publishes a per-table TypeScript SDK as a versioned npm package to GitHub
 * Packages (`@<scope>/logger-<table>`). The version is derived from the diff
 * between the table's current schema and the schema embedded in the
 * last-published package, so additive changes bump minor and
 * removed/renamed/retyped columns bump major — and an unchanged schema is a
 * no-op (no republish).
 *
 * GitHub Packages' npm registry only accepts a classic PAT (or the Actions
 * GITHUB_TOKEN) — it rejects GitHub App installation tokens — so this uses a
 * long-lived `write:packages` classic PAT, supplied via env, ideally owned by
 * a dedicated machine user. See plans/logger-sdk-github-packages.md.
 */

const PUBLISH_ENABLED = process.env.GITHUB_PACKAGES_PUBLISH_ENABLED === "true";
const TOKEN = process.env.GITHUB_PACKAGES_TOKEN;
const REGISTRY =
  process.env.GITHUB_PACKAGES_REGISTRY ?? "https://npm.pkg.github.com";
const SCOPE = process.env.GITHUB_PACKAGES_SCOPE ?? "@eloquio";
/**
 * GitHub org that owns the packages — derived from the scope so it tracks
 * GITHUB_PACKAGES_SCOPE. Used only to build the package's web URL; GitHub org
 * URLs are case-insensitive, so the lowercase scope works.
 */
const GH_ORG = SCOPE.replace(/^@/, "");

export interface PublishLoggerSdkResult {
  packageName: string;
  version: string;
  /**
   * "created"  — first publish of a brand-new package.
   * "published" — a new version of an existing package.
   * "unchanged" — schema identical to the latest published version; skipped.
   * "skipped"  — publishing disabled (local dev), nothing hit the network.
   */
  action: "created" | "published" | "unchanged" | "skipped";
  registryUrl: string;
  packageUrl: string;
}

// --------------------------------------------------------------------------
// I/O: read published state, pack tarball, publish.
// --------------------------------------------------------------------------

interface PublishedState {
  latestVersion: string;
  /** The latest version's embedded column signature, or null if unreadable. */
  schema: ColumnSig[] | null;
}

type PackumentVersion = { dist?: { tarball?: string } };
type Packument = {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
};

function is404(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode;
  const code = (err as { code?: string })?.code;
  return status === 404 || code === "E404";
}

/**
 * Extract `package/package.json` from a gzipped npm tarball buffer without
 * touching disk. tar auto-detects the gzip on read. Exported for tests.
 */
export function readPackageJsonFromTarball(
  buf: Buffer,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let parsed: Record<string, unknown> | null = null;
    const parser = tar.t({
      onentry(entry: tar.ReadEntry) {
        if (entry.path !== "package/package.json") {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => {
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
          }
        });
      },
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(parsed));
    parser.end(buf);
  });
}

/**
 * Read the embedded `lattikSchema` from a published version's tarball. We read
 * it from the tarball rather than the packument's version metadata because
 * custom top-level package.json fields are not guaranteed to survive a
 * registry's packument response — the tarball is the source of truth.
 *
 * Returns null when the tarball is genuinely absent (404) or carries no
 * signature (an older package predating `lattikSchema`); the caller then treats
 * the schema as unknown → a change rather than a skip. Any other non-ok status
 * (401/403/5xx) is fatal for the same reason a non-404 packument read is in
 * `fetchPublishedState`: we must NOT silently degrade to a spurious version
 * bump on an auth/transient failure — failing the step surfaces the problem.
 * Exported for tests.
 */
export async function fetchEmbeddedSchema(
  tarballUrl: string,
): Promise<ColumnSig[] | null> {
  // `tarballUrl` comes from the registry's packument response (`dist.tarball`).
  // Only forward the write-scoped PAT when the tarball is served by the same
  // host as the configured registry — otherwise a compromised/misconfigured
  // registry (or an unexpected GITHUB_PACKAGES_REGISTRY override) could
  // exfiltrate the credential to an arbitrary host. GitHub Packages always
  // co-locates tarballs on the registry host, so the happy path is unaffected;
  // a foreign host is fetched without auth and will surface as a non-ok status.
  const sameHost = new URL(tarballUrl).host === new URL(REGISTRY).host;
  const res = await fetch(tarballUrl, {
    headers: sameHost ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Failed to read published tarball (HTTP ${res.status}) from ${tarballUrl}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const pkg = await readPackageJsonFromTarball(buf);
  return Array.isArray(pkg?.lattikSchema)
    ? (pkg!.lattikSchema as ColumnSig[])
    : null;
}

/** Fetch the package's current published state, or null if never published. */
async function fetchPublishedState(
  packageName: string,
): Promise<PublishedState | null> {
  // npm-registry-fetch wants the escaped name as the URI path; for a scoped
  // package the "/" is percent-encoded but the "@" is kept.
  const escapedName = packageName.replace("/", "%2f");
  let packument: Packument;
  try {
    packument = (await npmFetch.json(escapedName, {
      registry: REGISTRY,
      forceAuth: { _authToken: TOKEN },
    })) as Packument;
  } catch (err) {
    if (is404(err)) return null;
    // Any other read failure (auth, 5xx, network) is intentionally fatal: we
    // must NOT guess a version, because publishing a wrong one would either
    // clobber semver semantics or silently skip the schema change. Failing the
    // step surfaces the problem rather than masking it.
    throw err;
  }

  const latest = packument["dist-tags"]?.latest;
  if (!latest) return null;
  const tarballUrl = packument.versions?.[latest]?.dist?.tarball;
  const schema = tarballUrl ? await fetchEmbeddedSchema(tarballUrl) : null;
  return { latestVersion: latest, schema };
}

/**
 * Build an npm tarball (gzipped, files under `package/`) from in-memory files.
 * Exported for tests. The temp dir is removed only after the tarball buffer is
 * fully assembled (the `await` on the stream promise sequences this before the
 * `finally`), so there's no read-after-delete race.
 */
export async function packTarball(files: PackageFile[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "lattik-sdk-"));
  try {
    const pkgDir = join(dir, "package");
    await mkdir(pkgDir, { recursive: true });
    await Promise.all(
      files.map((f) => writeFile(join(pkgDir, f.path), f.content, "utf8")),
    );
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      // `portable: true` strips mtime/uid/gid so the tarball is deterministic.
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, [
        "package",
      ]);
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Exported for tests. */
export function packageUrlFor(packageName: string): string {
  const unscoped = packageName.split("/")[1] ?? packageName;
  return `https://github.com/orgs/${GH_ORG}/packages/npm/package/${unscoped}`;
}

/**
 * Render, version, and publish the SDK package for a logger table.
 *
 * Idempotent under WDK step retries / webhook redelivery because: (a) the
 * version is derived deterministically from the schema diff, (b) an unchanged
 * schema is a no-op, and (c) a 409 (version already exists) is treated as
 * success. The caller (runLoggerTableStepsStep) invokes this sequentially per
 * table, so there is no concurrent publish of the same package within a run.
 */
export async function publishLoggerSdk(
  table: LoggerTable,
): Promise<PublishLoggerSdkResult> {
  const packageName = packageNameFor(table.name, SCOPE);
  const base = {
    packageName,
    registryUrl: REGISTRY,
    packageUrl: packageUrlFor(packageName),
  };

  // Local dev / preview: no token → record the would-be package without
  // touching the network, mirroring the FIREHOSE_ENABLED skip in firehose.ts.
  if (!PUBLISH_ENABLED) {
    return { ...base, version: "0.0.0-dev", action: "skipped" };
  }
  if (!TOKEN) {
    throw new Error(
      "GITHUB_PACKAGES_PUBLISH_ENABLED is true but GITHUB_PACKAGES_TOKEN is not set",
    );
  }

  const nextSchema = schemaSignature(table);
  const published = await fetchPublishedState(packageName);
  const decision = decidePublishAction({
    latestVersion: published?.latestVersion ?? null,
    prevSchema: published?.schema ?? null,
    nextSchema,
  });

  if (decision.action === "unchanged") {
    return { ...base, version: decision.version, action: "unchanged" };
  }

  const files = renderLoggerPackage(table, {
    version: decision.version,
    scope: SCOPE,
  });
  const manifest = JSON.parse(
    files.find((f) => f.path === "package.json")!.content,
  ) as Record<string, unknown>;
  const tarball = await packTarball(files);

  try {
    await publish(manifest, tarball, {
      registry: REGISTRY,
      forceAuth: { _authToken: TOKEN },
      defaultTag: "latest",
      // GitHub Packages controls package visibility via org/repo settings, not
      // the npm `access` field (it's ignored there), so we don't set it.
      provenance: false,
      npmVersion: "lattik-studio",
    });
  } catch (err) {
    // Duplicate publish of the same version (webhook redelivery / WDK step
    // retry) → it already landed; treat as success rather than failing the
    // step. npm-registry-fetch surfaces HTTP status as `statusCode` and code
    // `E<status>`; also match the registry's "already exists" message
    // defensively in case the status differs.
    const status = (err as { statusCode?: number })?.statusCode;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (
      status === 409 ||
      code === "E409" ||
      /already exists|cannot publish over/i.test(message)
    ) {
      return { ...base, version: decision.version, action: "published" };
    }
    throw err;
  }

  return { ...base, version: decision.version, action: decision.action };
}
