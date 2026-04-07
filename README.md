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

3. Set up your Vercel project and pull environment variables:

```bash
vercel link
vercel env pull
```

4. Push the database schema to Neon:

```bash
cd apps/web && pnpm drizzle-kit push
```

5. Add a background image at `apps/web/public/bg.avif`

6. Start the dev server:

```bash
pnpm dev
```

## Environment Variables

See `apps/web/.env.example`:

- `VERCEL_OIDC_TOKEN` — Vercel AI Gateway token
- `DATABASE_URL` — Neon Postgres connection string
- `AUTH_SECRET` — NextAuth secret
- `AUTH_GOOGLE_ID` — Google OAuth client ID
- `AUTH_GOOGLE_SECRET` — Google OAuth client secret

## Project Structure

```
apps/
  web/              — Next.js web app
    src/
      app/          — Pages and API routes
      components/   — UI components (chat, canvas, nav, ui)
      hooks/        — Custom React hooks
      auth/         — NextAuth configuration
      db/           — Drizzle schema and connection
packages/           — Shared packages (future)
```
