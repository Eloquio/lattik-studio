# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Root Cause Analysis Agent). Extension authors define agent logic and what renders on the canvas (charts, tables, etc.).

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 with AI Gateway (Claude Sonnet 4)
- **Auth:** NextAuth v5 (Auth.js beta) with Google OAuth
- **Database:** PostgreSQL (local via kind) + Drizzle ORM
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** portless (`https://lattik-studio.dev` via `--tld dev`)

## Project structure

```
apps/web/              Next.js app
  src/app/             Pages and API routes
  src/auth/            NextAuth config (Google provider, Drizzle adapter)
  src/components/      UI components (chat, canvas, layout, ui)
  src/db/              Drizzle schema and connection
  src/extensions/      Extension framework and agents
  src/hooks/           React hooks
  src/proxy.ts         Auth middleware (protects all routes)
k8s/                   Kubernetes manifests (kind cluster, PostgreSQL)
packages/              Shared packages (future)
```

## Development

```bash
# First time: create kind cluster and deploy PostgreSQL
pnpm db:start

# Push database schema
pnpm db:push

# Start portless proxy with .dev TLD (required for Google OAuth)
portless proxy start --tld dev

# Run dev server (serves at https://lattik-studio.dev)
pnpm dev

# Build
pnpm build

# Stop database cluster
pnpm db:stop
```

## Environment variables

Set in `apps/web/.env.local`:

- `AUTH_URL` — Must be `https://lattik-studio.dev` for local dev
- `AUTH_SECRET` — NextAuth secret
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://lattik:lattik-local@localhost:5432/lattik_studio`)
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway auth

## Database

PostgreSQL runs locally in a kind (Kubernetes in Docker) cluster.

```bash
# Start cluster + PostgreSQL
pnpm db:start

# Push Drizzle schema to the database
pnpm db:push

# Stop and delete the cluster (data is lost)
pnpm db:stop

# Connect via psql
psql postgresql://lattik:lattik-local@localhost:5432/lattik_studio

# Check pod status
kubectl get pods -l app=postgres
```

- **Driver:** `postgres` (postgres.js) via `drizzle-orm/postgres-js`
- **Connection:** `src/db/index.ts` — singleton with `globalThis` for HMR safety
- **Schema:** `src/db/schema.ts` — NextAuth tables (users, accounts, sessions, verificationTokens)
- **Migrations:** `drizzle-kit push` (schema-first, no migration files)
- **K8s manifests:** `k8s/kind-config.yaml` (cluster), `k8s/postgres.yaml` (Secret, PVC, Deployment, Service)
- **Port:** PostgreSQL exposed at `localhost:5432` via NodePort 30432

## Auth

- Google OAuth only, configured in `src/auth/index.ts`
- `src/proxy.ts` protects all routes; unauthenticated users redirect to `/sign-in`
- Google Console redirect URI: `https://lattik-studio.dev/api/auth/callback/google`

## Design

- Dark glassmorphic theme with frosted glass effects
- Fonts: Inter (sans), Geist Mono (mono), Homemade Apple (display)
- Accent color: `#e0a96e` (amber)
- Branding: "Lattik" in display font + "Studio" in amber
