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
- **Canvas rendering:** `@json-render/core` + `@json-render/react` ([vercel-labs/json-render](https://github.com/vercel-labs/json-render))
- **Expression engine:** `@eloquio/lattik-expression` (parse, type-check, emit SQL)
- **Git (local dev):** Gitea in kind cluster for PR review workflow

## Project structure

```
apps/web/              Next.js app
  src/app/             Pages and API routes
  src/auth/            NextAuth config (Google provider, Drizzle adapter)
  src/components/      UI components (chat, canvas, layout, ui)
  src/db/              Drizzle schema and connection
  src/extensions/      Extension framework and agents
    data-architect/    Data Architect extension (see README.md inside)
      canvas/          Canvas components + json-render system
      skills/          Skill markdown docs (entity, dimension, logger table, lattik table, metric)
      tools/           Agent tools (getSkill, renderCanvas, staticCheck, submitPR, etc.)
      validation/      Naming, referential, and expression validation
  src/hooks/           React hooks
  src/lib/             Server actions and utilities
  src/proxy.ts         Auth middleware (protects all routes except /sign-in, /api/auth, /api/webhooks)
k8s/                   Kubernetes manifests (kind cluster, PostgreSQL, Gitea)
packages/              Shared packages (future)
```

## Development

```bash
# First time: create kind cluster and deploy PostgreSQL
pnpm db:start

# Push database schema
pnpm db:push

# Start Gitea (optional — needed for PR workflow)
pnpm gitea:start
# Check init logs for GITEA_TOKEN:
pnpm gitea:init-logs

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

Set in `apps/web/.env` (gitignored):

- `AI_GATEWAY_API_KEY` — Vercel AI Gateway auth
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://lattik:lattik-local@localhost:5432/lattik_studio`)
- `AUTH_URL` — Must be `https://lattik-studio.dev` for local dev
- `AUTH_SECRET` — NextAuth secret (generate with `openssl rand -base64 32`)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials
- `GITEA_URL` — Gitea HTTP URL (default: `http://localhost:3300`)
- `GITEA_TOKEN` — Gitea API token (from `pnpm gitea:init-logs`)
- `GITEA_WEBHOOK_SECRET` — HMAC secret for webhook verification (generate with `openssl rand -hex 32`)

## Database

PostgreSQL runs locally in a kind (Kubernetes in Docker) cluster. Data persists at `/var/lib/lattik/postgres-data`.

```bash
# Start cluster + PostgreSQL
pnpm db:start

# Push Drizzle schema to the database
pnpm db:push

# Stop and delete the cluster
pnpm db:stop

# Connect via psql
psql postgresql://lattik:lattik-local@localhost:5432/lattik_studio

# Check pod status
kubectl get pods -l app=postgres
```

- **Driver:** `postgres` (postgres.js) via `drizzle-orm/postgres-js`
- **Connection:** `src/db/index.ts` — singleton with `globalThis` for HMR safety
- **Schema:** `src/db/schema.ts` — tables: users, accounts, sessions, verificationTokens (NextAuth), conversations (chat + canvas state), definitions (pipeline definitions lifecycle), agents, user_agents (marketplace)
- **Migrations:** `drizzle-kit push` (schema-first, no migration files)
- **K8s manifests:** `k8s/kind-config.yaml` (cluster), `k8s/postgres.yaml` (Secret, Deployment, Service)
- **Port:** PostgreSQL exposed at `localhost:5432` via NodePort 30432

## Auth

- Google OAuth only, configured in `src/auth/index.ts`
- `src/proxy.ts` protects all routes; unauthenticated users redirect to `/sign-in`
- API routes (`/api/chat`) also check auth explicitly
- Webhook routes (`/api/webhooks/*`) excluded from middleware, verified via HMAC
- Google Console redirect URI: `https://lattik-studio.dev/api/auth/callback/google`

## Extensions

Each extension has a `README.md` documenting its agent architecture, tools, canvas components, and workflows. Read the extension's README before making changes.

### Canvas Rules
All canvas UI MUST be rendered via `@json-render/react`. Define catalogs with `defineCatalog()`, register components with `defineRegistry()`, render with `<Renderer>`. State is managed by json-render's JSON Pointer state model (`$state`, `$bindState`, `setState` actions). The LLM streams JSONL patches via `pipeJsonRender()`, client applies them with `useJsonRenderMessage()`. Do NOT bypass json-render with custom renderers or direct React state for canvas content. Conversation and canvas state MUST survive page refresh — the full spec + state is persisted to the database and restored on load.

## Design

- Dark glassmorphic theme with frosted glass effects
- Fonts: Inter (sans), Geist Mono (mono), Homemade Apple (display)
- Accent color: `#e0a96e` (amber)
- Branding: "Lattik" in display font + "Studio" in amber
