import { z } from "zod";
import { log } from "@/lib/log";
import { verifyCallback } from "@/lib/sandbox-callback";
import { sandboxDoneHook } from "@/workflows/dag-runner-hooks";

const callbackBodySchema = z.object({
  token: z.string().min(1),
  ok: z.boolean(),
  exitCode: z.number().int(),
  signature: z.string().regex(/^[0-9a-f]+$/),
  errorMessage: z.string().optional(),
  stderrTail: z.string().optional(),
});

/**
 * POST /api/internal/sandbox-complete — invoked by the sandbox runner.js
 * when a task finishes (or hits its internal timeout). Verifies the
 * HMAC signature against the per-token derived key, then resumes the
 * matching workflow hook.
 *
 * Returns 204 on success, 401 on bad signature, 400 on malformed body.
 *
 * Auth at the network layer: Vercel Deployment Protection's `(this
 * project)` Trusted Sources rule accepts the sandbox's OIDC token
 * (forwarded as `x-vercel-trusted-oidc-idp-token`). The HMAC verification
 * here is the app-layer check that the body matches the token claimed
 * (and that nobody else with the URL can fire the hook).
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = callbackBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { token, ok, exitCode, signature, errorMessage, stderrTail } =
    parsed.data;

  if (!verifyCallback(token, ok, exitCode, signature)) {
    log.warn("sandbox_complete.bad_signature", { token: token.slice(0, 16) });
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }

  try {
    await sandboxDoneHook.resume(token, {
      ok,
      exitCode,
      errorMessage,
      stderrTail,
    });
  } catch (err) {
    // The hook may have been disposed already (e.g. watchdog fired first
    // and the workflow moved on). Don't surface this as a 5xx — the
    // runner has already exited and can't act on it.
    const message = err instanceof Error ? err.message : String(err);
    log.warn("sandbox_complete.resume_failed", {
      token: token.slice(0, 16),
      error: message,
    });
  }

  return new Response(null, { status: 204 });
}
