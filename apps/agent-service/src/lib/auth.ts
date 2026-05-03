/**
 * Trusted-client authentication for agent-service.
 *
 * Each chat client (apps/web, slack-bot, discord-bot, …) authenticates its
 * own users — agent-service never validates a NextAuth cookie or a Slack
 * signature. Instead, every request must carry:
 *
 *   - **Client identity** — verified via Vercel OIDC in production (Bearer
 *     token in Authorization, signed by Vercel, `sub` identifies the calling
 *     deployment). In local dev, NODE_ENV=development triggers a bypass that
 *     reads `X-Client-Id` directly.
 *   - **User identity** — asserted by the trusted client via `X-User-Id`.
 *     agent-service trusts the assertion because the client is verified.
 *
 * This module exports:
 *   - `verifyRequest(event)` — runs both checks, throws structured h3 errors
 *     on failure, returns `{ clientId, userId }` on success.
 *   - `attachAuth` — h3 middleware that calls `verifyRequest` and attaches
 *     the result to `event.context.auth`. Skips routes listed in
 *     `PUBLIC_ROUTES` (e.g. /health).
 */

import { createError, getHeader, getRequestPath, type H3Event } from "h3";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthContext {
  /** Identifier of the calling deployment (e.g. "web", "slack-bot"). */
  clientId: string;
  /** User on whose behalf the client is calling — asserted by the client. */
  userId: string;
}

declare module "h3" {
  interface H3EventContext {
    auth?: AuthContext;
  }
}

const PUBLIC_ROUTES = new Set<string>(["/health"]);

/**
 * Dev-mode auth bypass — when LATTIK_DEV_AUTH_BYPASS=1, the middleware reads
 * the trusted client id directly from `X-Client-Id` instead of verifying a
 * Vercel OIDC token. Only set this in local dev; it removes the production
 * trust boundary.
 *
 * Read at runtime (not module-init) on purpose: Nitro inlines build-time
 * env replacements, so a top-level constant captures the BUILD env, not the
 * RUNTIME env. The dedicated env var name avoids accidental NODE_ENV
 * inlining too.
 */
function isDevBypass(): boolean {
  return process.env.LATTIK_DEV_AUTH_BYPASS === "1";
}

/**
 * Comma-separated list of client ids the dev bypass accepts. Defaults to
 * "web,slack-bot,discord-bot" so local dev "just works"; tighten via env if
 * you want to model a specific failure mode. Read at runtime for the same
 * reason as the bypass flag.
 */
function devTrustedClients(): Set<string> {
  return new Set<string>(
    (process.env.LATTIK_DEV_TRUSTED_CLIENTS ?? "web,slack-bot,discord-bot")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Vercel OIDC issuer + JWKS, set per-team in production. Looks like
 * `https://oidc.vercel.com/<team-slug>`. The matching JWKS lives at
 * `<issuer>/.well-known/jwks.json`.
 *
 * Lazily-built so dev-mode startups don't need any of these env vars. A
 * production startup that hits the prod path with these unset throws a
 * 500 — the caller will notice immediately.
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (jwksCache) return jwksCache;
  const issuer = process.env.VERCEL_OIDC_ISSUER;
  if (!issuer) {
    throw createError({
      statusCode: 500,
      statusMessage:
        "VERCEL_OIDC_ISSUER not set — agent-service cannot verify client identity in production.",
    });
  }
  jwksCache = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return jwksCache;
}

/**
 * Allowlist of `sub` claims agent-service trusts. Each entry maps a Vercel
 * OIDC `sub` (e.g. `owner:abc:project:web:environment:production`) to the
 * canonical client id used downstream. Set via TRUSTED_CLIENTS env as
 * `<sub>=<clientId>,<sub>=<clientId>,…`.
 */
function buildSubAllowlist(): Map<string, string> {
  const raw = process.env.TRUSTED_CLIENTS ?? "";
  const out = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [sub, clientId] = pair.split("=");
    if (sub && clientId) out.set(sub, clientId);
  }
  return out;
}

let subAllowlist: Map<string, string> | null = null;

async function verifyVercelOidc(token: string): Promise<string> {
  const allow = (subAllowlist ??= buildSubAllowlist());
  const { payload } = await jwtVerify(token, getJWKS(), {
    issuer: process.env.VERCEL_OIDC_ISSUER ?? undefined,
  });
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const clientId = allow.get(sub);
  if (!clientId) {
    throw createError({
      statusCode: 403,
      statusMessage: `Untrusted OIDC subject: ${sub}`,
    });
  }
  return clientId;
}

/** Throws on auth failure; returns the resolved AuthContext on success. */
export async function verifyRequest(event: H3Event): Promise<AuthContext> {
  const userId = getHeader(event, "x-user-id");
  if (!userId) {
    throw createError({
      statusCode: 401,
      statusMessage: "Missing X-User-Id header",
    });
  }

  if (isDevBypass()) {
    const clientId = getHeader(event, "x-client-id");
    if (!clientId) {
      throw createError({
        statusCode: 401,
        statusMessage:
          "Missing X-Client-Id header (LATTIK_DEV_AUTH_BYPASS=1 requires it)",
      });
    }
    const trusted = devTrustedClients();
    if (!trusted.has(clientId)) {
      throw createError({
        statusCode: 403,
        statusMessage: `Untrusted client id "${clientId}" (LATTIK_DEV_TRUSTED_CLIENTS allows: ${[...trusted].join(", ")})`,
      });
    }
    return { clientId, userId };
  }

  const authHeader = getHeader(event, "authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw createError({
      statusCode: 401,
      statusMessage: "Missing or malformed Authorization header",
    });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const clientId = await verifyVercelOidc(token);
  return { clientId, userId };
}

/**
 * Path prefixes that bypass auth.
 *
 * - `/.well-known/workflow/` — the workflow SDK's internal callbacks
 *   (queue/dispatcher → step/flow/webhook routes). These are hit by the
 *   workflow runtime itself, not by external clients, so the trusted-
 *   client headers don't apply. Production deployments should rely on
 *   network-level isolation here; HMAC-signing the dispatcher→runtime
 *   hop is a separate hardening slice.
 */
const PUBLIC_PREFIXES = ["/.well-known/workflow/"];

/** h3 middleware. Skips public routes, verifies and attaches context otherwise. */
export async function attachAuth(event: H3Event): Promise<void> {
  const path = getRequestPath(event);
  if (PUBLIC_ROUTES.has(path)) return;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;
  event.context.auth = await verifyRequest(event);
}
