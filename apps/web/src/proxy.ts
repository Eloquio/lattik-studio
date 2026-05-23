import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth/config";

// IMPORTANT: import the edge-safe `authConfig`, not `@/auth`. The full auth
// module pulls in DrizzleAdapter + postgres-js, which fail at runtime inside
// the Next.js 16 proxy runtime ("TypeError: pb is not a function"). The proxy
// only needs to decode the JWT cookie, which doesn't require an adapter.
const { auth } = NextAuth(authConfig);

/**
 * Wraps NextAuth's `auth` middleware with a per-request Content-Security-Policy
 * nonce. The browser refuses to execute any inline <script> not tagged with
 * the matching nonce, which is what reclaims CSP's main XSS guarantee — even
 * if an attacker manages to inject an unintended <script> into our HTML, it
 * won't run.
 *
 * Flow:
 *   1. Generate a cryptographically random nonce per request.
 *   2. Forward the nonce on `x-nonce` so server components that emit inline
 *      scripts can read it via `headers().get("x-nonce")`. Next.js's own
 *      bootstrap scripts pick the nonce up automatically from the CSP header
 *      below.
 *   3. Set the CSP response header with `'nonce-<value>' 'strict-dynamic'`
 *      for scripts. `'strict-dynamic'` lets nonce-tagged scripts load further
 *      scripts they need (Next.js's chunk loader) without us having to
 *      enumerate them.
 *
 * Style-src still carries `'unsafe-inline'` because Tailwind v4 emits inline
 * <style> blocks during SSR and there's no equivalent nonce path for styles
 * in the current stack.
 */
const isDev = process.env.NODE_ENV !== "production";

function buildCsp(nonce: string): string {
  // In dev, Fast Refresh + React DevTools + Turbopack need `unsafe-eval` and
  // additional `unsafe-inline` allowances for HMR. We KEEP `unsafe-inline`
  // alongside the nonce in dev (browsers prefer the nonce when present, so
  // dev tooling continues to work). In prod we drop both `unsafe-inline` and
  // `unsafe-eval` — only nonce-tagged scripts and what they load via
  // `strict-dynamic` are allowed to execute.
  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind v4 emits inline <style> during SSR; nonce'ing styles requires
    // upstream work we haven't done yet.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://ai-gateway.vercel.sh https://accounts.google.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64 — `btoa` works in middleware's edge-compatible runtime.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Next.js 16's proxy.ts runtime check requires a default-exported function
// declaration (or a named `proxy` const). The `export const proxy = auth(...)`
// form silently fails at runtime with "must export a function named `proxy` or
// a default function" even though the build-time scan accepts it. Wrapping the
// auth handler in a default-exported `function proxy` declaration is the
// defensive form that satisfies both checks. See vercel/next.js#85648.
const handler = auth((req) => {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Propagate the nonce to downstream RSC/route handlers so they can attach
  // it to any inline <script> they need to render.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  res.headers.set("Content-Security-Policy", csp);
  return res;
});

export default function proxy(...args: Parameters<typeof handler>) {
  return handler(...args);
}

export const config = {
  // We KEEP /sign-in inside the matcher (vs. excluding it like the other
  // routes below) so it picks up the per-request CSP. NextAuth's `auth`
  // wrapper short-circuits redirects to the configured signIn page, so
  // there's no risk of a /sign-in → /sign-in redirect loop for
  // unauthenticated users. API routes return JSON, not HTML, so CSP is
  // not useful for them; static assets bypass middleware entirely.
  matcher: ["/((?!api/auth|api/webhooks|api/runs|api/cron|api/lattik|_next/static|_next/image|favicon.ico|bg.avif).*)"],
};
