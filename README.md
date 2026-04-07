# AI Chat Template

A glassmorphic AI chat application template built with Next.js, Vercel AI SDK, and shadcn/ui.

## Features

- Three-column layout: nav sidebar, chat panel, resizable canvas
- Dark frosted glass (glassmorphic) theme
- AI chat powered by Vercel AI Gateway (Claude)
- Resizable canvas panel with localStorage persistence
- Google OAuth via NextAuth (Auth.js v5)
- Neon Postgres database with Drizzle ORM
- shadcn/ui components (Base Nova style)
- Inter + Geist Mono + Homemade Apple fonts

## Tech Stack

- **Framework:** Next.js 16 (App Router) with Turborepo
- **AI:** Vercel AI SDK v6 + AI Gateway
- **UI:** shadcn/ui + Tailwind CSS v4
- **Auth:** NextAuth (Auth.js v5) with Google provider
- **Database:** Neon (Postgres) + Drizzle ORM
- **Package Manager:** pnpm

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

2. Clone the repo and install dependencies:

```bash
pnpm install
```

3. Set up your environment variables by copying `apps/web/.env.example` to `apps/web/.env` and filling in the values:

```bash
cp apps/web/.env.example apps/web/.env
```

4. Start the local PostgreSQL cluster (runs in kind) and push the database schema:

```bash
pnpm db:start
pnpm db:push
```

5. Start the [portless](https://github.com/vercel-labs/portless) proxy with the `.dev` TLD (required for Google OAuth, which expects `https://lattik-studio.dev`):

```bash
portless proxy start --tld dev
```

6. (Optional) Start Gitea for the PR review workflow, then grab the API token from the init logs and set `GITEA_TOKEN` in `apps/web/.env`:

```bash
pnpm gitea:start
pnpm gitea:init-logs
```

7. Start the dev server:

```bash
pnpm dev
```
