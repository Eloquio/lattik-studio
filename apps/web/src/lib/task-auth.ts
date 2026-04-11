/**
 * Bearer token authentication for task queue API routes.
 * Agents authenticate with `Authorization: Bearer <TASK_AGENT_SECRET>`.
 */

export function verifyTaskSecret(req: Request): boolean {
  const secret = process.env.TASK_AGENT_SECRET;
  if (!secret) {
    throw new Error("TASK_AGENT_SECRET is not configured");
  }
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
}

/**
 * Guard helper for route handlers. Returns a 401 Response if auth fails,
 * or null if auth succeeds.
 */
export function requireTaskAuth(req: Request): Response | null {
  try {
    if (!verifyTaskSecret(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }
}
