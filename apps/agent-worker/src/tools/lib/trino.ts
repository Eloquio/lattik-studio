/**
 * Minimal Trino HTTP client for the agent-worker.
 *
 * Trino's REST API: POST /v1/statement returns a {nextUri} we keep polling
 * until the query reaches a terminal state (FINISHED / FAILED / CANCELED).
 * Sufficient for short DDL/admin statements; not designed for fetching
 * paged result sets.
 */

const TRINO_URL = process.env.TRINO_URL ?? "http://localhost:8080";
const TRINO_USER = process.env.TRINO_USER ?? "lattik-agent-worker";
const TRINO_CATALOG = "iceberg";
const STATEMENT_TIMEOUT_MS = 30_000;

interface TrinoStats {
  state: string;
}

interface TrinoError {
  message: string;
  errorCode?: number;
  errorName?: string;
}

interface TrinoResponse {
  id: string;
  nextUri?: string;
  stats?: TrinoStats;
  error?: TrinoError;
}

export class TrinoExecError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "TrinoExecError";
  }
}

export async function executeStatement(
  sql: string,
  options: { catalog?: string; schema?: string } = {},
): Promise<{ id: string; durationMs: number }> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
    "X-Trino-User": TRINO_USER,
    "X-Trino-Catalog": options.catalog ?? TRINO_CATALOG,
  };
  if (options.schema) {
    headers["X-Trino-Schema"] = options.schema;
  }

  let res = await fetch(`${TRINO_URL}/v1/statement`, {
    method: "POST",
    headers,
    body: sql,
  });
  if (!res.ok) {
    throw new TrinoExecError(
      `Trino /v1/statement returned ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  let body = (await res.json()) as TrinoResponse;

  while (body.nextUri) {
    if (Date.now() - startedAt > STATEMENT_TIMEOUT_MS) {
      throw new TrinoExecError(
        `Trino statement timed out after ${STATEMENT_TIMEOUT_MS}ms (id ${body.id})`,
      );
    }
    res = await fetch(body.nextUri);
    if (!res.ok) {
      throw new TrinoExecError(
        `Trino poll returned ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }
    body = (await res.json()) as TrinoResponse;
    if (body.error) {
      throw new TrinoExecError(body.error.message, body.error.errorName);
    }
    const state = body.stats?.state;
    if (state === "FINISHED") break;
    if (state === "FAILED" || state === "CANCELED") {
      throw new TrinoExecError(`Trino statement ended in state ${state}`, state);
    }
  }

  return { id: body.id, durationMs: Date.now() - startedAt };
}
