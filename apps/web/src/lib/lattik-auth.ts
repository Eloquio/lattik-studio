/**
 * Bearer-token authentication for the Lattik Table commit API.
 *
 * The commit API is called by Spark batch drivers (write path) and the
 * Trino/Spark read-path connectors. Both sides authenticate with
 * `Authorization: Bearer <LATTIK_API_TOKEN>`.
 *
 * The token is a shared secret stored as an env var on the web app and
 * mounted via a Kubernetes secret on Spark driver/executor pods.
 */

export function verifyLattikSecret(req: Request): boolean {
  const secret = process.env.LATTIK_API_TOKEN;
  if (!secret) {
    throw new Error("LATTIK_API_TOKEN is not configured");
  }
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
}

/**
 * Guard helper for route handlers. Returns a 401 Response if auth fails,
 * or null if auth succeeds.
 */
export function requireLattikAuth(req: Request): Response | null {
  try {
    if (!verifyLattikSecret(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }
}
