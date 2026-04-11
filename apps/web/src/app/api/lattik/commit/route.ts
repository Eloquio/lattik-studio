import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireLattikAuth } from "@/lib/bearer-auth";
import { log } from "@/lib/log";
import { getJsonObject, putObject } from "@/lib/s3-client";

const S3_BUCKET = process.env.S3_DAG_BUCKET ?? "warehouse";

/**
 * Schema name ( `schema.table` ) and column identifiers. SQL is already
 * parameterized via Drizzle, but these strings end up in S3 keys, manifest
 * JSON, and downstream Spark jobs that interpolate them into DAG YAML, so
 * we enforce a strict allowlist up front to avoid path-traversal, odd
 * characters in S3 keys, and surprises in Spark/Trino.
 */
const identifierRe = /^[a-z_][a-z0-9_]{0,62}$/;
const tableNameRe = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
const loadIdRe = /^[A-Za-z0-9_-]{4,64}$/;
const dsRe = /^\d{4}-\d{2}-\d{2}$/;

const commitBodySchema = z.object({
  table_name: z.string().regex(tableNameRe, {
    message: "table_name must be in 'schema.table' format (lowercase letters, digits, underscore)",
  }),
  base_version: z.number().int().nonnegative(),
  load_id: z.string().regex(loadIdRe, {
    message: "load_id must be 4-64 chars of [A-Za-z0-9_-]",
  }),
  columns: z
    .record(z.string().regex(identifierRe), z.string().regex(loadIdRe))
    .refine((c) => Object.keys(c).length > 0, {
      message: "columns must be non-empty",
    }),
  ds: z.string().regex(dsRe, { message: "ds must be YYYY-MM-DD" }),
  hour: z.number().int().min(0).max(23).nullable(),
});

/**
 * POST /api/lattik/commit
 *
 * Atomic commit for a Lattik Table stitch load. Called by the batch writer
 * (Spark job) after writing load files to S3.
 *
 * The endpoint:
 * 1. Validates the request
 * 2. Reads the current base version from Postgres
 * 3. Builds the new manifest (carrying forward base columns, overriding with new loads)
 * 4. Writes the manifest to S3
 * 5. Atomically INSERTs into lattik_table_commits + UPSERTs lattik_column_loads
 * 6. Returns { status: "committed", version } or { status: "conflict", base_version }
 *
 * The caller (Spark job) handles conflicts by rebasing and retrying.
 */
export async function POST(request: Request) {
  const authError = requireLattikAuth(request);
  if (authError) {
    log.warn("lattik.commit.unauthorized", {});
    return authError;
  }

  const startedAt = Date.now();
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("lattik.commit.invalid_json", {});
    return Response.json(
      { status: "error", message: "Request body is not valid JSON" },
      { status: 400 },
    );
  }

  const parsed = commitBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    log.warn("lattik.commit.invalid_request", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return Response.json(
      {
        status: "error",
        message: "Invalid request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { table_name, base_version, load_id, columns, ds, hour } = parsed.data;

  log.info("lattik.commit.start", {
    table_name,
    base_version,
    load_id,
    ds,
    hour,
    column_count: Object.keys(columns).length,
  });

  const db = getDb();

  // Idempotency: if we already committed this exact (table_name, load_id),
  // return the existing result instead of creating a second manifest. The
  // driver may legitimately retry after a network error between sending the
  // request and receiving the response; without this check the retry would
  // either succeed with a bumped version (duplicate data) or fail with a
  // 23505 conflict against itself.
  const existing = await db
    .select()
    .from(schema.lattikTableCommits)
    .where(
      and(
        eq(schema.lattikTableCommits.tableName, table_name),
        eq(schema.lattikTableCommits.manifestLoadId, load_id),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    log.info("lattik.commit.idempotent_replay", {
      table_name,
      load_id,
      version: existing[0].manifestVersion,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({
      status: "committed",
      version: existing[0].manifestVersion,
      manifest_load_id: existing[0].manifestLoadId,
      replayed: true,
    });
  }

  // Read the current base manifest from S3
  const baseCommit = await db
    .select()
    .from(schema.lattikTableCommits)
    .where(
      and(
        eq(schema.lattikTableCommits.tableName, table_name),
        eq(schema.lattikTableCommits.manifestVersion, base_version),
      ),
    )
    .limit(1);

  let baseColumns: Record<string, string> = {};

  if (baseCommit.length > 0) {
    // Fetch the base manifest from S3 to get the current column→load map.
    // A missing manifest (v0000 bootstrap) is expected; any other S3 error
    // is logged and propagated — we can't safely carry columns forward if
    // we can't read the base manifest.
    const baseLoadId = baseCommit[0].manifestLoadId;
    const manifestKey = `lattik/${table_name}/manifests/v${String(base_version).padStart(4, "0")}_${baseLoadId}.json`;
    try {
      const manifest = await getJsonObject<{ columns?: Record<string, string> }>(
        S3_BUCKET,
        manifestKey,
      );
      if (manifest) baseColumns = manifest.columns ?? {};
    } catch (err) {
      log.error("lattik.commit.base_manifest_unreadable", {
        table_name,
        base_version,
        manifest_key: manifestKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { status: "error", message: "Base manifest is unreadable" },
        { status: 503 },
      );
    }
  }

  // Build new column map: carry forward base, override with new loads
  const newColumns: Record<string, string> = { ...baseColumns, ...columns };
  const newVersion = base_version + 1;

  // Write new manifest to S3 (immutable, filename includes load_id to avoid collision)
  const manifestKey = `lattik/${table_name}/manifests/v${String(newVersion).padStart(4, "0")}_${load_id}.json`;
  const manifest = JSON.stringify(
    { version: newVersion, columns: newColumns },
    null,
    2,
  );

  await putObject(S3_BUCKET, manifestKey, manifest);

  // Atomic commit to Postgres
  try {
    await db.transaction(async (tx) => {
      // 1. INSERT into commit log — PK constraint = OCC
      await tx.insert(schema.lattikTableCommits).values({
        tableName: table_name,
        manifestVersion: newVersion,
        manifestLoadId: load_id,
      });

      // 2. UPSERT per-column ETL time tracking
      for (const [columnName, colLoadId] of Object.entries(columns)) {
        await tx
          .insert(schema.lattikColumnLoads)
          .values({
            tableName: table_name,
            columnName,
            ds,
            hour,
            loadId: colLoadId,
            manifestVersion: newVersion,
          })
          .onConflictDoUpdate({
            target: [
              schema.lattikColumnLoads.tableName,
              schema.lattikColumnLoads.columnName,
              schema.lattikColumnLoads.ds,
              schema.lattikColumnLoads.hour,
            ],
            set: {
              loadId: sql`excluded.load_id`,
              manifestVersion: sql`excluded.manifest_version`,
              committedAt: sql`now()`,
            },
          });
      }
    });

    log.info("lattik.commit.committed", {
      table_name,
      version: newVersion,
      load_id,
      ds,
      hour,
      column_count: Object.keys(columns).length,
      duration_ms: Date.now() - startedAt,
    });

    return Response.json({
      status: "committed",
      version: newVersion,
      manifest_load_id: load_id,
    });
  } catch (err: unknown) {
    // Check for unique violation (OCC conflict on lattik_table_commits PK)
    const pgError = err as { code?: string };
    if (pgError.code === "23505") {
      // Another writer committed this version first — return conflict
      const latest = await db
        .select()
        .from(schema.lattikTableCommits)
        .where(eq(schema.lattikTableCommits.tableName, table_name))
        .orderBy(desc(schema.lattikTableCommits.manifestVersion))
        .limit(1);

      log.info("lattik.commit.conflict", {
        table_name,
        attempted_version: newVersion,
        latest_version: latest[0]?.manifestVersion ?? base_version,
        duration_ms: Date.now() - startedAt,
      });

      return Response.json({
        status: "conflict",
        base_version: latest[0]?.manifestVersion ?? base_version,
        base_load_id: latest[0]?.manifestLoadId,
      });
    }

    log.error("lattik.commit.failed", {
      table_name,
      base_version,
      load_id,
      ds,
      hour,
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * GET /api/lattik/commit?table=<name>&mode=latest|wall_time|ds&ts=<timestamp>&ds=<date>&hour=<hour>
 *
 * Resolve a manifest version for reading. Returns the manifest_version and
 * manifest_load_id for the requested time travel mode.
 */
export async function GET(request: Request) {
  const authError = requireLattikAuth(request);
  if (authError) {
    log.warn("lattik.commit.read.unauthorized", {});
    return authError;
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const tableName = url.searchParams.get("table");
  const mode = url.searchParams.get("mode") ?? "latest";

  if (!tableName || !tableNameRe.test(tableName)) {
    log.warn("lattik.commit.read.invalid_request", { mode, tableName });
    return Response.json(
      { status: "error", message: "Missing or invalid 'table' parameter" },
      { status: 400 },
    );
  }

  if (mode !== "latest" && mode !== "wall_time" && mode !== "ds") {
    log.warn("lattik.commit.read.invalid_request", {
      table_name: tableName,
      mode,
      reason: "unknown_mode",
    });
    return Response.json(
      { status: "error", message: `Unknown mode: ${mode}` },
      { status: 400 },
    );
  }

  log.info("lattik.commit.read.start", {
    table_name: tableName,
    mode,
  });

  const db = getDb();

  if (mode === "latest") {
    const result = await db
      .select()
      .from(schema.lattikTableCommits)
      .where(eq(schema.lattikTableCommits.tableName, tableName))
      .orderBy(desc(schema.lattikTableCommits.manifestVersion))
      .limit(1);

    if (result.length === 0) {
      log.info("lattik.commit.read.not_found", {
        table_name: tableName,
        mode,
        duration_ms: Date.now() - startedAt,
      });
      return Response.json(
        { status: "error", message: `No commits for table '${tableName}'` },
        { status: 404 },
      );
    }

    log.info("lattik.commit.read.resolved", {
      table_name: tableName,
      mode,
      manifest_version: result[0].manifestVersion,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({
      status: "ok",
      manifest_version: result[0].manifestVersion,
      manifest_load_id: result[0].manifestLoadId,
    });
  }

  if (mode === "wall_time") {
    const ts = url.searchParams.get("ts");
    const tsDate = ts ? new Date(ts) : null;
    if (!ts || !tsDate || Number.isNaN(tsDate.getTime())) {
      log.warn("lattik.commit.read.invalid_request", {
        table_name: tableName,
        mode,
        reason: ts ? "invalid_ts" : "missing_ts",
      });
      return Response.json(
        { status: "error", message: "Missing or invalid 'ts' parameter for wall_time mode" },
        { status: 400 },
      );
    }

    const result = await db
      .select()
      .from(schema.lattikTableCommits)
      .where(
        and(
          eq(schema.lattikTableCommits.tableName, tableName),
          sql`${schema.lattikTableCommits.committedAt} <= ${tsDate}`,
        ),
      )
      .orderBy(desc(schema.lattikTableCommits.committedAt))
      .limit(1);

    if (result.length === 0) {
      log.info("lattik.commit.read.not_found", {
        table_name: tableName,
        mode,
        ts,
        duration_ms: Date.now() - startedAt,
      });
      return Response.json(
        { status: "error", message: `No commits for '${tableName}' before ${ts}` },
        { status: 404 },
      );
    }

    log.info("lattik.commit.read.resolved", {
      table_name: tableName,
      mode,
      ts,
      manifest_version: result[0].manifestVersion,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({
      status: "ok",
      manifest_version: result[0].manifestVersion,
      manifest_load_id: result[0].manifestLoadId,
    });
  }

  if (mode === "ds") {
    const dsParam = url.searchParams.get("ds");
    const hourParam = url.searchParams.get("hour");
    const columnParam = url.searchParams.get("columns"); // comma-separated

    if (!dsParam || !dsRe.test(dsParam)) {
      log.warn("lattik.commit.read.invalid_request", {
        table_name: tableName,
        mode,
        reason: dsParam ? "invalid_ds" : "missing_ds",
        ds: dsParam,
      });
      return Response.json(
        { status: "error", message: "Missing or invalid 'ds' parameter (YYYY-MM-DD)" },
        { status: 400 },
      );
    }

    let hourInt: number | null = null;
    if (hourParam !== null) {
      const parsedHour = Number.parseInt(hourParam, 10);
      if (Number.isNaN(parsedHour) || parsedHour < 0 || parsedHour > 23) {
        log.warn("lattik.commit.read.invalid_request", {
          table_name: tableName,
          mode,
          reason: "invalid_hour",
          hour: hourParam,
        });
        return Response.json(
          { status: "error", message: "'hour' must be an integer in [0, 23]" },
          { status: 400 },
        );
      }
      hourInt = parsedHour;
    }

    const rows = await db
      .select()
      .from(schema.lattikColumnLoads)
      .where(
        and(
          eq(schema.lattikColumnLoads.tableName, tableName),
          eq(schema.lattikColumnLoads.ds, dsParam),
          hourInt !== null
            ? eq(schema.lattikColumnLoads.hour, hourInt)
            : sql`true`,
        ),
      );

    // If hour not specified, pick the latest hour per column
    const columnLoads: Record<string, { load_id: string; hour: number | null }> = {};
    for (const row of rows) {
      const existing = columnLoads[row.columnName];
      if (
        !existing ||
        (row.hour ?? -1) > (existing.hour ?? -1)
      ) {
        columnLoads[row.columnName] = { load_id: row.loadId, hour: row.hour };
      }
    }

    // Filter to requested columns if specified
    if (columnParam) {
      const requestedColumns = columnParam.split(",");
      const missing = requestedColumns.filter((c) => !columnLoads[c]);
      if (missing.length > 0) {
        log.info("lattik.commit.read.not_found", {
          table_name: tableName,
          mode,
          ds: dsParam,
          hour: hourParam,
          requested: requestedColumns,
          missing,
          duration_ms: Date.now() - startedAt,
        });
        return Response.json({
          status: "error",
          message: `Columns not loaded for ds=${dsParam}: ${missing.join(", ")}`,
          available: Object.keys(columnLoads),
          missing,
        }, { status: 404 });
      }
    }

    const result: Record<string, string> = {};
    for (const [col, info] of Object.entries(columnLoads)) {
      result[col] = info.load_id;
    }

    log.info("lattik.commit.read.resolved", {
      table_name: tableName,
      mode,
      ds: dsParam,
      hour: hourParam,
      column_count: Object.keys(result).length,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({
      status: "ok",
      ds: dsParam,
      columns: result,
    });
  }

  log.warn("lattik.commit.read.invalid_request", {
    table_name: tableName,
    mode,
    reason: "unknown_mode",
  });
  return Response.json(
    { status: "error", message: `Unknown mode: ${mode}` },
    { status: 400 },
  );
}
