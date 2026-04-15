import duckdb from "duckdb";
import type { TrinoColumn, TrinoQueryResult } from "./trino-client";
import { TrinoQueryError } from "./trino-client";

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? "lattik";
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "lattik-local";
const LATTIK_WAREHOUSE_PATH =
  process.env.LATTIK_WAREHOUSE_PATH ?? "s3://warehouse/lattik";

const MAX_ROWS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Path to the compiled DuckDB extension (.duckdb_extension). When set, the
 * client loads it on first use. Leave unset to skip extension loading
 * (queries that don't use `lattik_scan` will still work).
 */
const DUCKDB_EXTENSION_PATH = process.env.DUCKDB_EXTENSION_PATH;

// ---------------------------------------------------------------------------
// Singleton DuckDB instance (one per Next.js server process)
// ---------------------------------------------------------------------------

let _db: duckdb.Database | null = null;
let _initPromise: Promise<void> | null = null;

function getDb(): duckdb.Database {
  if (!_db) {
    _db = new duckdb.Database(":memory:");
  }
  return _db;
}

function initDuckDb(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = new Promise<void>((resolve, reject) => {
    const db = getDb();
    const conn = db.connect();

    const statements = [
      `SET s3_endpoint='${S3_ENDPOINT.replace(/^https?:\/\//, "")}'`,
      `SET s3_access_key_id='${S3_ACCESS_KEY}'`,
      `SET s3_secret_access_key='${S3_SECRET_KEY}'`,
      `SET s3_use_ssl=false`,
      `SET s3_url_style='path'`,
    ];

    if (DUCKDB_EXTENSION_PATH) {
      statements.push(`LOAD '${DUCKDB_EXTENSION_PATH}'`);
    }

    let idx = 0;
    const next = () => {
      if (idx >= statements.length) {
        conn.close();
        resolve();
        return;
      }
      conn.run(statements[idx++]!, (err: Error | null) => {
        if (err) {
          conn.close();
          reject(err);
          return;
        }
        next();
      });
    };
    next();
  });

  return _initPromise;
}

// ---------------------------------------------------------------------------
// Read-only validation (same rules as trino-client.ts)
// ---------------------------------------------------------------------------

const ALLOWED_PREFIXES = ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"];

const BLOCKED_KEYWORDS = [
  "DROP",
  "DELETE",
  "INSERT",
  "UPDATE",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "MERGE",
];

function validateReadOnly(sql: string): void {
  const cleaned = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/;+$/, "")
    .trim();

  const firstWord = cleaned.split(/\s+/)[0]?.toUpperCase() ?? "";

  if (!ALLOWED_PREFIXES.includes(firstWord)) {
    throw new TrinoQueryError(
      `Only read-only queries are allowed. Got: ${firstWord}`,
      "READ_ONLY_VIOLATION"
    );
  }

  const upper = cleaned.toUpperCase();
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      throw new TrinoQueryError(
        `Statement contains blocked keyword: ${kw}`,
        "READ_ONLY_VIOLATION"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Execute a query via DuckDB
// ---------------------------------------------------------------------------

/**
 * Execute a read-only SQL query against DuckDB. Returns the same result
 * shape as the Trino client so the runQuery tool can use either.
 */
export async function executeDuckDbQuery(
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number }
): Promise<TrinoQueryResult> {
  const maxRows = options?.maxRows ?? MAX_ROWS;
  const timeoutMs = options?.timeoutMs ?? QUERY_TIMEOUT_MS;

  validateReadOnly(sql);

  await initDuckDb();

  const start = Date.now();

  return new Promise<TrinoQueryResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TrinoQueryError(`Query timed out after ${timeoutMs}ms`, "TIMEOUT")
      );
    }, timeoutMs);

    const db = getDb();
    const conn = db.connect();

    conn.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
      clearTimeout(timer);
      conn.close();

      if (err) {
        reject(
          new TrinoQueryError(
            `DuckDB query failed: ${err.message}`,
            "DUCKDB_QUERY_ERROR"
          )
        );
        return;
      }

      if (!rows || rows.length === 0) {
        resolve({
          columns: [],
          rows: [],
          rowCount: 0,
          queryId: "duckdb-local",
          durationMs: Date.now() - start,
          truncated: false,
        });
        return;
      }

      // Extract column names from the first row's keys
      const columnNames = Object.keys(rows[0]!);
      const columns: TrinoColumn[] = columnNames.map((name) => ({
        name,
        type: inferType(rows[0]![name]),
      }));

      const truncated = rows.length > maxRows;
      const resultRows = rows.slice(0, maxRows).map((row) =>
        columnNames.map((col) => row[col])
      );

      resolve({
        columns,
        rows: resultRows,
        rowCount: resultRows.length,
        queryId: "duckdb-local",
        durationMs: Date.now() - start,
        truncated,
      });
    });
  });
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "varchar";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "bigint" : "double";
  }
  if (typeof value === "boolean") return "boolean";
  return "varchar";
}

// ---------------------------------------------------------------------------
// Query routing
// ---------------------------------------------------------------------------

/**
 * Returns true if the query references `lattik_scan` — meaning it should
 * be routed through DuckDB with the stitch extension rather than Trino.
 */
export function isLattikScanQuery(sql: string): boolean {
  return /\blattik_scan\s*\(/i.test(sql);
}
