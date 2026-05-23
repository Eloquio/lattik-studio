import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["lattik-studio.dev"],
  transpilePackages: ["@eloquio/lattik-expression"],
  serverExternalPackages: ["duckdb"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          // CSP is set per-request by src/proxy.ts so we can attach a
          // per-request nonce to scripts. Don't add a static CSP here —
          // two CSP headers intersect (most-restrictive wins), which would
          // either over-restrict the per-request CSP or, if the static one
          // is more permissive, give a false sense of security.
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
