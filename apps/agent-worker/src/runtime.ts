/**
 * Worker runtime — env access + an authenticated fetch helper.
 *
 * Centralizes the bearer-auth header and base URL so tools don't each
 * reimplement the wire format. Identity comes from LATTIK_WORKER_ID +
 * LATTIK_WORKER_SECRET, the same shape task-client.ts uses.
 */

const API_BASE = process.env.TASK_API_URL;
const WORKER_ID = process.env.LATTIK_WORKER_ID;
const WORKER_SECRET = process.env.LATTIK_WORKER_SECRET;

if (!API_BASE) {
  throw new Error("TASK_API_URL is required");
}
if (!WORKER_ID || !WORKER_SECRET) {
  throw new Error(
    "LATTIK_WORKER_ID and LATTIK_WORKER_SECRET are required — register the worker first",
  );
}

const apiBase = API_BASE;
const authHeader = `Bearer ${WORKER_ID}:${WORKER_SECRET}`;

export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/**
 * Authenticated JSON fetch. Throws on non-2xx so tool implementations can
 * surface errors via try/catch and return a structured error to the LLM.
 * Returns parsed JSON, or null for 204 / no-body responses.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T | null> {
  const res = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${options.method ?? "POST"} ${path} → ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return (await res.json()) as T;
}
