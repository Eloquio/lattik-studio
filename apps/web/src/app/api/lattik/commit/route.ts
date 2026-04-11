import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { putObject } from "@/lib/s3-client";

const S3_BUCKET = process.env.S3_DAG_BUCKET ?? "warehouse";

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
  const body = await request.json();

  const {
    table_name,
    base_version,
    load_id,
    columns,
    ds,
    hour,
  } = body as {
    table_name: string;
    base_version: number;
    load_id: string;
    /** Column overrides: { column_name: load_id } */
    columns: Record<string, string>;
    ds: string;
    hour: number | null;
  };

  if (!table_name || base_version === undefined || !load_id || !columns || !ds) {
    return Response.json(
      { status: "error", message: "Missing required fields" },
      { status: 400 },
    );
  }

  const db = getDb();

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
    // Fetch the base manifest from S3 to get the current column→load map
    const baseLoadId = baseCommit[0].manifestLoadId;
    const manifestKey = `lattik/${table_name}/manifests/v${String(base_version).padStart(4, "0")}_${baseLoadId}.json`;

    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { S3Client } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
        region: process.env.S3_REGION ?? "us-east-1",
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "lattik",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "lattik-local",
        },
        forcePathStyle: true,
      });
      const result = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: manifestKey }),
      );
      const text = await result.Body?.transformToString();
      if (text) {
        const manifest = JSON.parse(text);
        baseColumns = manifest.columns ?? {};
      }
    } catch {
      // If base manifest doesn't exist (e.g., v0000_init), start with empty columns
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

      return Response.json({
        status: "conflict",
        base_version: latest[0]?.manifestVersion ?? base_version,
        base_load_id: latest[0]?.manifestLoadId,
      });
    }

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
  const url = new URL(request.url);
  const tableName = url.searchParams.get("table");
  const mode = url.searchParams.get("mode") ?? "latest";

  if (!tableName) {
    return Response.json(
      { status: "error", message: "Missing 'table' parameter" },
      { status: 400 },
    );
  }

  const db = getDb();

  if (mode === "latest") {
    const result = await db
      .select()
      .from(schema.lattikTableCommits)
      .where(eq(schema.lattikTableCommits.tableName, tableName))
      .orderBy(desc(schema.lattikTableCommits.manifestVersion))
      .limit(1);

    if (result.length === 0) {
      return Response.json(
        { status: "error", message: `No commits for table '${tableName}'` },
        { status: 404 },
      );
    }

    return Response.json({
      status: "ok",
      manifest_version: result[0].manifestVersion,
      manifest_load_id: result[0].manifestLoadId,
    });
  }

  if (mode === "wall_time") {
    const ts = url.searchParams.get("ts");
    if (!ts) {
      return Response.json(
        { status: "error", message: "Missing 'ts' parameter for wall_time mode" },
        { status: 400 },
      );
    }

    const result = await db
      .select()
      .from(schema.lattikTableCommits)
      .where(
        and(
          eq(schema.lattikTableCommits.tableName, tableName),
          sql`${schema.lattikTableCommits.committedAt} <= ${new Date(ts)}`,
        ),
      )
      .orderBy(desc(schema.lattikTableCommits.committedAt))
      .limit(1);

    if (result.length === 0) {
      return Response.json(
        { status: "error", message: `No commits for '${tableName}' before ${ts}` },
        { status: 404 },
      );
    }

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

    if (!dsParam) {
      return Response.json(
        { status: "error", message: "Missing 'ds' parameter" },
        { status: 400 },
      );
    }

    let query = db
      .select()
      .from(schema.lattikColumnLoads)
      .where(
        and(
          eq(schema.lattikColumnLoads.tableName, tableName),
          eq(schema.lattikColumnLoads.ds, dsParam),
          hourParam
            ? eq(schema.lattikColumnLoads.hour, parseInt(hourParam))
            : sql`true`,
        ),
      );

    const rows = await query;

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

    return Response.json({
      status: "ok",
      ds: dsParam,
      columns: result,
    });
  }

  return Response.json(
    { status: "error", message: `Unknown mode: ${mode}` },
    { status: 400 },
  );
}
