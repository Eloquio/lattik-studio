const TRINO_URL = process.env.TRINO_URL ?? "http://localhost:8080";
const TRINO_USER = "lattik-studio";
const MAX_ROWS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

export interface TrinoColumn {
  name: string;
  type: string;
}

export interface TrinoQueryResult {
  columns: TrinoColumn[];
  rows: unknown[][];
  rowCount: number;
  queryId: string;
  durationMs: number;
  truncated: boolean;
}

/**
 * Trino identifier regex — letter/underscore prefix, alphanumeric+underscore
 * tail. Stricter than what Trino accepts inside `"…"` quoting on purpose:
 * agent-supplied identifiers shouldn't carry punctuation, and a strict regex
 * is a clean second line of defense behind the quote escaping below.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

export class TrinoIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrinoIdentifierError";
  }
}

/**
 * Quote a single Trino identifier safely. Validates against IDENT_RE and
 * doubles any internal `"` (Trino's standard escape) before wrapping. Use
 * this for any catalog/schema/table name that originated from an LLM or
 * external input.
 */
export function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new TrinoIdentifierError(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a dotted table reference like `catalog.schema.table` (1–3 parts).
 * Each segment is validated and quoted individually.
 */
export function quoteTableRef(ref: string): string {
  const parts = ref.split(".");
  if (parts.length < 1 || parts.length > 3) {
    throw new TrinoIdentifierError(
      `Invalid table reference (expected 1–3 dotted segments): ${JSON.stringify(ref)}`,
    );
  }
  return parts.map(quoteIdent).join(".");
}

/**
 * Statements we allow the analyst agent to execute. Everything else is
 * rejected before it reaches Trino.
 */
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
  // Strip leading whitespace, comments, and semicolons
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

  // Extra safety: scan for blocked keywords at statement boundaries
  const upper = cleaned.toUpperCase();
  for (const kw of BLOCKED_KEYWORDS) {
    // Match keyword at word boundary (not inside an identifier)
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      throw new TrinoQueryError(
        `Statement contains blocked keyword: ${kw}`,
        "READ_ONLY_VIOLATION"
      );
    }
  }
}

export class TrinoQueryError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "TrinoQueryError";
  }
}

interface TrinoStatementResponse {
  id: string;
  infoUri?: string;
  nextUri?: string;
  columns?: { name: string; type: string }[];
  data?: unknown[][];
  stats?: { state: string; elapsedTimeMillis?: number };
  error?: { message: string; errorCode?: number; errorName?: string };
}

/**
 * Execute a read-only SQL query against Trino and collect all result pages.
 */
export async function executeQuery(
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number }
): Promise<TrinoQueryResult> {
  const maxRows = options?.maxRows ?? MAX_ROWS;
  const timeoutMs = options?.timeoutMs ?? QUERY_TIMEOUT_MS;

  validateReadOnly(sql);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    // Submit query
    const submitRes = await fetch(`${TRINO_URL}/v1/statement`, {
      method: "POST",
      headers: {
        "X-Trino-User": TRINO_USER,
        "X-Trino-Source": "lattik-studio-data-analyst",
        "Content-Type": "text/plain",
      },
      body: sql,
      signal: controller.signal,
    });

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new TrinoQueryError(
        `Trino returned ${submitRes.status}: ${text}`,
        "TRINO_HTTP_ERROR"
      );
    }

    let response = (await submitRes.json()) as TrinoStatementResponse;

    // Collect results across pagination
    let columns: TrinoColumn[] = [];
    const allRows: unknown[][] = [];
    let truncated = false;

    while (true) {
      if (response.error) {
        throw new TrinoQueryError(
          response.error.message,
          response.error.errorName ?? "TRINO_QUERY_ERROR"
        );
      }

      if (response.columns && columns.length === 0) {
        columns = response.columns.map((c) => ({
          name: c.name,
          type: c.type,
        }));
      }

      if (response.data) {
        for (const row of response.data) {
          if (allRows.length >= maxRows) {
            truncated = true;
            break;
          }
          allRows.push(row);
        }
      }

      if (!response.nextUri || truncated) break;

      // Fetch next page
      const nextRes = await fetch(response.nextUri, {
        method: "GET",
        headers: { "X-Trino-User": TRINO_USER },
        signal: controller.signal,
      });

      if (!nextRes.ok) {
        throw new TrinoQueryError(
          `Trino pagination failed: ${nextRes.status}`,
          "TRINO_HTTP_ERROR"
        );
      }

      response = (await nextRes.json()) as TrinoStatementResponse;
    }

    return {
      columns,
      rows: allRows,
      rowCount: allRows.length,
      queryId: response.id,
      durationMs: Date.now() - start,
      truncated,
    };
  } catch (err) {
    if (err instanceof TrinoQueryError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new TrinoQueryError(
        `Query timed out after ${timeoutMs}ms`,
        "TIMEOUT"
      );
    }
    throw new TrinoQueryError(
      `Failed to connect to Trino at ${TRINO_URL}: ${(err as Error).message}`,
      "CONNECTION_ERROR"
    );
  } finally {
    clearTimeout(timer);
  }
}
