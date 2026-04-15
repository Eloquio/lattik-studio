#!/usr/bin/env bash
set -e

# Single entry point for local development.
# 1. Preflight checks
# 2. Environment bootstrap (.env generation)
# 3. Required services (kind cluster, Postgres, schema, seed)
# 4. Next.js dev server (foreground)
# 5. Remaining services in background (images, Gitea, Trino, Kafka, etc.)

# Step 1: Preflight
node scripts/preflight.mjs

# Step 2: Environment
pnpm env:bootstrap

# Step 3: Required services
pnpm cluster:up
pnpm db:start
pnpm db:push
pnpm db:seed

# Guidance between setup and dev server
node scripts/print-next-steps.mjs

# Step 5: Remaining services in background
pnpm dev:services > .dev-services.log 2>&1 &

# Step 4: Start the web (+ agent-worker + tsc watch) — foreground
exec turbo dev
