# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Root Cause Analysis Agent). Extension authors define agent logic and what renders on the canvas (charts, tables, etc.).

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 with AI Gateway (Claude Sonnet 4)
- **Auth:** NextAuth v5 (Auth.js beta) with Google OAuth
- **Database:** Neon (serverless Postgres) + Drizzle ORM
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** portless (`https://lattik-studio.dev` via `--tld dev`)

## Project structure

```
apps/web/              Next.js app
  src/app/             Pages and API routes
  src/auth/            NextAuth config (Google provider, Drizzle adapter)
  src/components/      UI components (chat, canvas, layout, ui)
  src/db/              Drizzle schema and connection
  src/hooks/           React hooks
  src/proxy.ts         Auth middleware (protects all routes)
packages/              Shared packages (future)
```

## Development

```bash
# Start portless proxy with .dev TLD (required for Google OAuth)
portless proxy start --tld dev

# Run dev server (serves at https://lattik-studio.dev)
pnpm dev

# Build
pnpm build

# Database migrations
cd apps/web && npx drizzle-kit push
```

## Environment variables

Set in `apps/web/.env.local`:

- `AUTH_URL` — Must be `https://lattik-studio.dev` for local dev
- `AUTH_SECRET` — NextAuth secret
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials
- `DATABASE_URL` — Neon Postgres connection string
- `VERCEL_OIDC_TOKEN` — Vercel AI Gateway auth

## Auth

- Google OAuth only, configured in `src/auth/index.ts`
- `src/proxy.ts` protects all routes; unauthenticated users redirect to `/sign-in`
- Google Console redirect URI: `https://lattik-studio.dev/api/auth/callback/google`

## Design

- Dark glassmorphic theme with frosted glass effects
- Fonts: Inter (sans), Geist Mono (mono), Homemade Apple (display)
- Accent color: `#e0a96e` (amber)
- Branding: "Lattik" in display font + "Studio" in amber
