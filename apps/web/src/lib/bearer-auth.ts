/**
 * Generic bearer-token guard for API routes that authenticate against a
 * shared secret stored in an env var. Used by the Lattik Table commit API
 * (LATTIK_API_TOKEN) and request-level task queue endpoints (TASK_AGENT_SECRET).
 *
 * Throws a clear error when the env var is unset so misconfiguration is
 * surfaced as a 500 rather than silently letting requests through.
 *
 * Worker endpoints (claim/complete/fail) use `requireWorkerAuth` instead —
 * that path validates a per-worker token stored in the DB so a compromised
 * process can be revoked without rotating a fleet-wide secret.
 */

import { verifyWorkerToken } from "@/lib/worker-tokens";

function verifyBearer(req: Request, envVar: string): boolean {
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`${envVar} is not configured`);
  }
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
}

/**
 * Guard helper for route handlers. Returns a 401 Response on auth failure,
 * a 500 Response on misconfiguration, or `null` on success.
 */
export function requireBearer(req: Request, envVar: string): Response | null {
  try {
    if (!verifyBearer(req, envVar)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }
}

/** Lattik Table commit API auth (LATTIK_API_TOKEN). */
export function requireLattikAuth(req: Request): Response | null {
  return requireBearer(req, "LATTIK_API_TOKEN");
}

/**
 * Task queue API auth for request-level endpoints (TASK_AGENT_SECRET).
 * Used by webhook handlers and human-operated request-management endpoints.
 * Workers do NOT use this — they authenticate per-worker instead.
 */
export function requireTaskAuth(req: Request): Response | null {
  return requireBearer(req, "TASK_AGENT_SECRET");
}

/**
 * Per-worker bearer auth for worker endpoints. Expects
 * `Authorization: Bearer <workerId>:<secret>`. On success, returns the
 * authenticated worker id; on failure, returns a 401 Response the route
 * can propagate directly.
 */
export async function requireWorkerAuth(
  req: Request,
): Promise<{ workerId: string } | Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workerId = await verifyWorkerToken(auth.slice(7));
  if (!workerId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { workerId };
}
