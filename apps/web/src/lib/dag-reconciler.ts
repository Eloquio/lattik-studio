import { basename } from "node:path";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { load as parseYaml } from "js-yaml";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { fetchBlobText, fetchManifest, type Branch } from "./dag-blob";
import { dagDefSchema, type DagDef } from "@/schemas/dag";
import type { Manifest } from "@/schemas/manifest";

/** Derive a DAG id from its source path (e.g. `dags/foo.yaml` → `foo`). */
function deriveIdFromPath(path: string): string {
  return basename(path).replace(/\.ya?ml$/i, "");
}

/**
 * Thrown when a branch's `manifest.json` is absent. The caller (e.g.
 * /api/sync) should map this to a 4xx — we deliberately do NOT fall back
 * to scanning Blob, since without per-DAG hashes we can't tell what
 * changed.
 */
export class ManifestMissingError extends Error {
  readonly branch: Branch;
  constructor(branch: Branch) {
    super(`manifest.json missing for branch '${branch}'`);
    this.name = "ManifestMissingError";
    this.branch = branch;
  }
}

/**
 * For PR branches, every DAG id is suffixed with `_pr_<n>`. The YAML's
 * `id` field stays the original (e.g. `daily-revenue`); the row's `id` in
 * DB is what gets the suffix so prod and PR rows coexist.
 */
export function dagRowId(dagYamlId: string, branch: Branch): string {
  if (branch === "prod") return dagYamlId;
  const n = branch.replace(/^pr-/, "");
  return `${dagYamlId}_pr_${n}`;
}

export interface ReconcileResult {
  branch: Branch;
  /** Manifest entries that were fetched + upserted (new + changed + un-archived). */
  dagsProcessed: number;
  /** Manifest entries that matched DB hash exactly — no fetch, no write. */
  dagsUnchanged: number;
  /** Rows soft-archived because their id was absent from the manifest. */
  dagsArchived: number;
  errors: Array<{ pathname: string; message: string }>;
}

/**
 * Idempotent, manifest-driven reconciler.
 *
 * 1. Read `manifest.json` (fail-closed if missing) — or use the inline
 *    manifest if the caller passed one (e.g. /api/sync from lattik-pipelines).
 * 2. Load existing rows for the branch keyed by `source_path`.
 * 3. Skip every entry whose `(source_path, sha256)` matches an *active* row.
 * 4. For the rest, fetch the YAML, validate, and upsert with the new hash.
 * 5. Soft-archive any branch row whose `id` is absent from the manifest.
 *
 * `options.manifest` lets the caller bypass the Blob fetch. The
 * lattik-pipelines GHA passes its just-written manifest inline to sidestep
 * Vercel Blob's put-then-read consistency window.
 */
export async function reconcileDags(
  branch: Branch,
  _bundleSha: string,
  options: { manifest?: Manifest } = {}
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    branch,
    dagsProcessed: 0,
    dagsUnchanged: 0,
    dagsArchived: 0,
    errors: [],
  };

  const manifest = options.manifest ?? (await fetchManifest(branch));
  if (!manifest) throw new ManifestMissingError(branch);

  const existingRows = await getDb()
    .select({
      id: schema.dags.id,
      sourcePath: schema.dags.sourcePath,
      yamlHash: schema.dags.yamlHash,
      archivedAt: schema.dags.archivedAt,
    })
    .from(schema.dags)
    .where(eq(schema.dags.branch, branch));
  const existingBySourcePath = new Map(
    existingRows.map((r) => [r.sourcePath, r])
  );

  const seenIds: string[] = [];

  for (const entry of manifest.dags) {
    const existing = existingBySourcePath.get(entry.path);

    if (
      existing &&
      existing.yamlHash === entry.sha256 &&
      existing.archivedAt === null
    ) {
      seenIds.push(existing.id);
      result.dagsUnchanged += 1;
      continue;
    }

    let parsed: DagDef;
    let yamlText: string;
    try {
      yamlText = await fetchBlobText(entry.path);
      const yamlData = parseYaml(yamlText);
      if (
        yamlData !== null &&
        typeof yamlData === "object" &&
        !Array.isArray(yamlData) &&
        (yamlData as Record<string, unknown>).id === undefined
      ) {
        (yamlData as Record<string, unknown>).id = deriveIdFromPath(entry.path);
      }
      parsed = dagDefSchema.parse(yamlData);
    } catch (err) {
      result.errors.push({
        pathname: entry.path,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const rowId = dagRowId(parsed.id, branch);
    seenIds.push(rowId);

    const startDateIso =
      typeof parsed.startDate === "string"
        ? parsed.startDate.slice(0, 10)
        : new Date(parsed.startDate).toISOString().slice(0, 10);

    await getDb()
      .insert(schema.dags)
      .values({
        id: rowId,
        branch,
        sourcePath: entry.path,
        yamlRaw: yamlText,
        yamlHash: entry.sha256,
        parsed,
        schedule: parsed.schedule,
        timezone: parsed.timezone,
        startDate: startDateIso,
        catchup: parsed.catchup,
        maxActiveRuns: parsed.maxActiveRuns,
        archivedAt: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.dags.id, schema.dags.branch],
        set: {
          sourcePath: entry.path,
          yamlRaw: yamlText,
          yamlHash: entry.sha256,
          parsed,
          schedule: parsed.schedule,
          timezone: parsed.timezone,
          startDate: startDateIso,
          catchup: parsed.catchup,
          maxActiveRuns: parsed.maxActiveRuns,
          archivedAt: null,
          updatedAt: new Date(),
        },
      });

    result.dagsProcessed += 1;
  }

  if (seenIds.length > 0) {
    const archived = await getDb()
      .update(schema.dags)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.dags.branch, branch),
          isNull(schema.dags.archivedAt),
          notInArray(schema.dags.id, seenIds)
        )
      )
      .returning({ id: schema.dags.id });
    result.dagsArchived = archived.length;
  } else {
    result.dagsArchived = await archiveBranch(branch);
  }

  return result;
}

/**
 * Soft-archive every active row for a branch. Used by the PR-close path
 * (when wired) so the empty-manifest write doesn't race the reconciler
 * read.
 */
export async function archiveBranch(branch: Branch): Promise<number> {
  const archived = await getDb()
    .update(schema.dags)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(schema.dags.branch, branch), isNull(schema.dags.archivedAt))
    )
    .returning({ id: schema.dags.id });
  return archived.length;
}
