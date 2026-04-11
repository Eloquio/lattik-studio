/**
 * Generic bearer-token guard for API routes that authenticate against a
 * shared secret stored in an env var. Used by the Lattik Table commit API
 * (LATTIK_API_TOKEN) and the task queue API (TASK_AGENT_SECRET).
 *
 * Throws a clear error when the env var is unset so misconfiguration is
 * surfaced as a 500 rather than silently letting requests through.
 */

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

/** Task queue API auth (TASK_AGENT_SECRET). */
export function requireTaskAuth(req: Request): Response | null {
  return requireBearer(req, "TASK_AGENT_SECRET");
}
