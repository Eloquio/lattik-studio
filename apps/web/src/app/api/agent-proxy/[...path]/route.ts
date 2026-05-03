import { auth } from "@/auth";

/**
 * /api/agent-proxy/* — the trusted-client bridge between apps/web (the
 * NextAuth-authenticated browser) and apps/agent-service.
 *
 * Phase 1 of the multi-client agent service plan settled the auth
 * boundary as "client validates its own users, then asserts the user
 * identity to agent-service over OIDC-verified service-to-service
 * trust." This proxy is web's half of that bridge:
 *
 *   1. Validate the NextAuth session — refuse the proxy without one.
 *   2. Resolve the userId from the session.
 *   3. Forward the request to agent-service with:
 *        Authorization: Bearer <VERCEL_OIDC_TOKEN>   (production)
 *        X-Client-Id: web                            (asserted client identity)
 *        X-User-Id: <session userId>                 (asserted user identity)
 *   4. Pipe the SSE response straight back to the browser.
 *
 * For local dev, agent-service runs with LATTIK_DEV_AUTH_BYPASS=1 and
 * accepts the X-Client-Id header without an OIDC token. We forward the
 * headers either way; agent-service decides which path to validate.
 */

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3939";

async function proxy(req: Request, path: string[]): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const upstreamUrl = `${AGENT_SERVICE_URL}/${path.join("/")}`;
  const upstreamHeaders = new Headers();
  const incomingContentType = req.headers.get("content-type");
  if (incomingContentType) {
    upstreamHeaders.set("Content-Type", incomingContentType);
  }
  upstreamHeaders.set("X-Client-Id", "web");
  upstreamHeaders.set("X-User-Id", userId);

  // Vercel auto-issues VERCEL_OIDC_TOKEN per request to functions running
  // on Fluid Compute. In local dev the var is absent — the request still
  // works because agent-service trusts the X-Client-Id header when
  // LATTIK_DEV_AUTH_BYPASS=1 is set.
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken) {
    upstreamHeaders.set("Authorization", `Bearer ${oidcToken}`);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
      // Required by undici when streaming a Request body — without it the
      // fetch implementation refuses the duplex stream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "agent-service unreachable",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Pipe the upstream stream straight back. Preserve the SSE-relevant
  // headers (content-type, the AI SDK's UI-message-stream marker, the
  // Vercel-x-accel-buffering hint).
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lowered = key.toLowerCase();
    if (
      lowered === "content-type" ||
      lowered === "cache-control" ||
      lowered === "x-accel-buffering" ||
      lowered.startsWith("x-vercel-ai-")
    ) {
      responseHeaders.set(key, value);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
