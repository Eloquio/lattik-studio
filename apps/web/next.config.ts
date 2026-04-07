import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Next.js dev (Fast Refresh, React Server Components) and React DevTools both
// rely on `eval`, so `unsafe-eval` is unavoidable in development. In
// production we drop it to reclaim CSP's main XSS guarantee.
//
// `unsafe-inline` for scripts is still required because Next.js inlines small
// runtime bootstrap snippets in SSR HTML; eliminating it requires per-request
// CSP nonces. That's a worthwhile follow-up but out of scope for this pass —
// the high-impact win is removing `unsafe-eval` in production.
const scriptSrc = ["'self'", "'unsafe-inline'", isDev && "'unsafe-eval'"]
  .filter(Boolean)
  .join(" ");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["lattik-studio.dev"],
  transpilePackages: ["@eloquio/lattik-expression"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src ${scriptSrc}`,
              // Tailwind CSS v4 emits inline <style> tags during SSR, so
              // 'unsafe-inline' for styles is still required.
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://ai-gateway.vercel.sh https://accounts.google.com",
              "frame-ancestors 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
