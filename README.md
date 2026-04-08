# Lattik Studio

Agentic analytics platform. Users solve analytics needs through chat-driven workflows — building data pipelines, asking business questions, root cause analysis, ML feature engineering. Lattik Studio connects to the Data Lake (S3 + Iceberg) and serves as a control plane for infra, logger tables, and pipelines.

Extensions are specialized AI agents (e.g. a Data Architect, a Root Cause Analysis Agent). Extension authors define the agent logic and what renders on the canvas (charts, tables, YAML editors, etc.).

## Features

- Three-column layout: nav sidebar, chat panel, resizable canvas
- Dark frosted glass (glassmorphic) theme
- Agentic chat powered by Vercel AI Gateway (Claude Sonnet 4)
- Extension framework for building specialized AI agents
- Streaming canvas rendered with [`@json-render/react`](https://github.com/vercel-labs/json-render); conversation + canvas state persisted to Postgres and restored on reload
- Google OAuth via NextAuth (Auth.js v5)
- Local PostgreSQL via a kind (Kubernetes in Docker) cluster, managed with Drizzle ORM
- Local Gitea (also in kind) for the pipeline PR review workflow
- shadcn/ui components (Base Nova style)
- Inter + Geist Mono + Homemade Apple fonts

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Monorepo:** Turborepo + pnpm workspaces
- **AI:** Vercel AI SDK v6 + AI Gateway (Claude Sonnet 4)
- **Auth:** NextAuth v5 (Auth.js beta) with Google provider
- **Database:** PostgreSQL (local via kind) + Drizzle ORM
- **UI:** shadcn/ui (Base Nova) + Tailwind CSS v4
- **Dev server:** [portless](https://github.com/vercel-labs/portless) (`https://lattik-studio.dev` via `--tld dev`)
- **Canvas rendering:** [`@json-render/core`](https://github.com/vercel-labs/json-render) + `@json-render/react`
- **Expression engine:** `@eloquio/lattik-expression` (parse, type-check, emit SQL)
- **Git (local dev):** Gitea in kind cluster for the PR review workflow

## Getting Started

1. Install pnpm (if you don't have it already):

```bash
# Via npm
npm install -g pnpm

# Or via Homebrew (macOS)
brew install pnpm

# Or via standalone script
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

See [pnpm.io/installation](https://pnpm.io/installation) for more options.

2. Install [kind](https://kind.sigs.k8s.io/) (used to run PostgreSQL and Gitea locally in a Kubernetes cluster). kind requires a container runtime — Docker Desktop is the easiest option on macOS:

```bash
# macOS (Homebrew)
brew install kind

# Linux / other (download the binary)
# See https://kind.sigs.k8s.io/docs/user/quick-start/#installation
```

Make sure Docker Desktop (or another supported runtime) is running before continuing.

3. Clone the repo and install dependencies:

```bash
pnpm install
```

4. Set up your environment variables by copying `apps/web/.env.example` to `apps/web/.env` and filling in the values:

```bash
cp apps/web/.env.example apps/web/.env
```

5. Create the kind cluster, deploy PostgreSQL into it, push the database schema, and seed the first-party agents (Data Architect, etc.) into the marketplace:

```bash
pnpm cluster:up
pnpm db:start
pnpm db:push
pnpm db:seed
```

> All in-cluster services (postgres, gitea, minio, iceberg-rest) store their data on PVCs backed by kind's default StorageClass. Data persists across pod restarts and `pnpm db:stop`/`pnpm db:start` cycles, but is wiped when you `pnpm dev:down` (which deletes the kind cluster). For most local-dev work this is fine; if you need to keep something across a recreate, snapshot it out (`pg_dump`, `mc cp`, etc.) first.

> Tip: `pnpm dev:up` brings up the cluster *and* every optional service (postgres, gitea, trino + minio + iceberg-rest) in one command. Use it once you've finished the rest of this setup and want a one-shot way to start your dev env. `pnpm dev:down` tears it all down.

6. Start the [portless](https://github.com/vercel-labs/portless) proxy with the `.dev` TLD (required for Google OAuth, which expects `https://lattik-studio.dev`):

```bash
portless proxy start --tld dev
```

7. (Optional) Start Gitea for the PR review workflow, then grab the API token from the init logs and set `GITEA_TOKEN` in `apps/web/.env`:

```bash
pnpm gitea:start
pnpm gitea:init-logs
```

8. Start the dev server:

```bash
pnpm dev
```
