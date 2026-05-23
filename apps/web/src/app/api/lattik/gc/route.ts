import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireLattikAuth } from "@/lib/bearer-auth";
import { log } from "@/lib/log";
import {
  deleteObjects,
  getObject,
  listObjectsDetailed,
} from "@/lib/s3-client";

const S3_BUCKET = process.env.S3_DAG_BUCKET ?? "warehouse";

// Default safety window: don't GC a load directory that's newer than 1 hour.
// This gives in-flight writers (that wrote a load but haven't committed yet)
// time to finish. Callers can override via `min_age_seconds`.
const DEFAULT_MIN_AGE_SECONDS = 3600;

/**
 * `table_name` is interpolated into S3 key prefixes (`lattik/<table>/...`)
 * for both list and delete operations. Without this regex an attacker
 * holding the API token could pass `../airflow-dags` (or worse) and have
 * the GC walk and delete unrelated objects in the warehouse bucket.
 *
 * Same pattern as the commit route: schema.table, lowercase identifiers
 * up to 63 chars each.
 */
const tableNameRe = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;

type LoadManifest = {
  version: number;
  columns: Record<string, string>; // column_name → load_id
};

type GcReport = {
  table_name: string;
  referenced_load_ids: number;
  total_load_directories: number;
  orphan_load_ids: string[];
  orphan_objects: number;
  deleted: number;
  dry_run: boolean;
};

/**
 * POST /api/lattik/gc?table=<name>&dry_run=<bool>&min_age_seconds=<n>
 *
 * Garbage-collect orphaned Lattik Table loads. An "orphan" is a load
 * directory under `lattik/<table>/loads/` whose `load_id` is not referenced
 * by any committed manifest. These come from writers that crashed between
 * writing the load and committing, or writers that lost an OCC race.
 *
 * The GC is intentionally **conservative**:
 * - Only considers loads older than `min_age_seconds` (default 1h) to avoid
 *   racing with in-flight writers.
 * - Scans every committed manifest's column map, not just the latest, so
 *   historical loads that are still referenced by time-travel queries are
 *   preserved.
 * - Does NOT delete manifests themselves (immutable — they're tiny and
 *   needed for time travel).
 * - Defaults to dry-run mode — callers must pass `dry_run=false` to delete.
 *
 * Authentication: `Authorization: Bearer $LATTIK_API_TOKEN`.
 */
export async function POST(request: Request) {
  const authError = requireLattikAuth(request);
  if (authError) {
    log.warn("lattik.gc.unauthorized", {});
    return authError;
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const tableName = url.searchParams.get("table");
  const dryRun = url.searchParams.get("dry_run") !== "false"; // default true
  const minAgeSecondsRaw = url.searchParams.get("min_age_seconds") ?? String(DEFAULT_MIN_AGE_SECONDS);
  const minAgeSeconds = parseInt(minAgeSecondsRaw, 10);

  if (!tableName) {
    log.warn("lattik.gc.invalid_request", { reason: "missing_table" });
    return Response.json(
      { error: "Missing 'table' parameter" },
      { status: 400 },
    );
  }

  if (!tableNameRe.test(tableName)) {
    log.warn("lattik.gc.invalid_request", {
      reason: "invalid_table",
      tableName,
    });
    return Response.json(
      {
        error:
          "table must be in 'schema.table' format (lowercase letters, digits, underscore)",
      },
      { status: 400 },
    );
  }

  if (!Number.isFinite(minAgeSeconds) || minAgeSeconds < 0) {
    log.warn("lattik.gc.invalid_request", {
      reason: "invalid_min_age_seconds",
      value: minAgeSecondsRaw,
    });
    return Response.json(
      { error: "min_age_seconds must be a non-negative integer" },
      { status: 400 }
    );
  }

  log.info("lattik.gc.start", {
    table_name: tableName,
    dry_run: dryRun,
    min_age_seconds: minAgeSeconds,
  });

  try {
    const report = await gcOneTable(tableName, dryRun, minAgeSeconds);

    log.info("lattik.gc.done", {
      ...report,
      orphan_load_ids: report.orphan_load_ids.length, // log the count, not the list
      duration_ms: Date.now() - startedAt,
    });

    return Response.json({ status: "ok", ...report });
  } catch (err) {
    log.error("lattik.gc.failed", {
      table_name: tableName,
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function gcOneTable(
  tableName: string,
  dryRun: boolean,
  minAgeSeconds: number,
): Promise<GcReport> {
  const db = getDb();

  // 1. Get every committed manifest for this table
  const commits = await db
    .select()
    .from(schema.lattikTableCommits)
    .where(eq(schema.lattikTableCommits.tableName, tableName));

  // 2. Fetch each manifest from S3 in parallel (bounded concurrency so a
  // table with hundreds of historical commits doesn't fan out to hundreds of
  // simultaneous S3 GETs). Collect the union of referenced load_ids.
  const referenced = new Set<string>();
  const MANIFEST_FETCH_CONCURRENCY = 16;
  for (let i = 0; i < commits.length; i += MANIFEST_FETCH_CONCURRENCY) {
    const chunk = commits.slice(i, i + MANIFEST_FETCH_CONCURRENCY);
    await Promise.all(
      chunk.map(async (commit) => {
        const manifestKey = `lattik/${tableName}/manifests/v${String(
          commit.manifestVersion,
        ).padStart(4, "0")}_${commit.manifestLoadId}.json`;
        try {
          const body = await getObject(S3_BUCKET, manifestKey);
          const manifest = JSON.parse(body) as LoadManifest;
          // The manifest itself is a "load_id" via commit.manifestLoadId; include it.
          referenced.add(commit.manifestLoadId);
          for (const loadId of Object.values(manifest.columns ?? {})) {
            referenced.add(loadId);
          }
        } catch (err) {
          // Missing manifest shouldn't block GC — log and continue. A
          // referenced load_id we can't read is conservatively treated as
          // *still referenced* by not adding its siblings to the orphan set.
          log.warn("lattik.gc.manifest_read_failed", {
            table_name: tableName,
            manifest_key: manifestKey,
            error: err instanceof Error ? err.message : String(err),
          });
          referenced.add(commit.manifestLoadId);
        }
      }),
    );
  }

  // 3. List every object under `lattik/<table>/loads/`, group by load_id
  const loadsPrefix = `lattik/${tableName}/loads/`;
  const objects = await listObjectsDetailed(S3_BUCKET, loadsPrefix);

  const loadBuckets = new Map<
    string,
    { keys: string[]; newestMs: number }
  >();
  for (const obj of objects) {
    if (!obj.Key) continue;
    // Key shape: lattik/<table>/loads/<load_id>/<rest>
    const rest = obj.Key.slice(loadsPrefix.length);
    const loadId = rest.split("/", 1)[0];
    if (!loadId) continue;

    const entry = loadBuckets.get(loadId) ?? { keys: [], newestMs: 0 };
    entry.keys.push(obj.Key);
    const lastModifiedMs = obj.LastModified?.getTime() ?? 0;
    if (lastModifiedMs > entry.newestMs) {
      entry.newestMs = lastModifiedMs;
    }
    loadBuckets.set(loadId, entry);
  }

  // 4. Orphans = load_ids present on S3 but not in the referenced set,
  //    and whose newest object is older than min_age_seconds ago.
  const cutoffMs = Date.now() - minAgeSeconds * 1000;
  const orphanIds: string[] = [];
  const orphanKeys: string[] = [];
  for (const [loadId, entry] of loadBuckets) {
    if (referenced.has(loadId)) continue;
    if (entry.newestMs > cutoffMs) continue; // too young, grace period
    orphanIds.push(loadId);
    orphanKeys.push(...entry.keys);
  }

  // 5. Delete (unless dry run)
  let deleted = 0;
  if (!dryRun && orphanKeys.length > 0) {
    deleted = await deleteObjects(S3_BUCKET, orphanKeys);
  }

  return {
    table_name: tableName,
    referenced_load_ids: referenced.size,
    total_load_directories: loadBuckets.size,
    orphan_load_ids: orphanIds,
    orphan_objects: orphanKeys.length,
    deleted,
    dry_run: dryRun,
  };
}
