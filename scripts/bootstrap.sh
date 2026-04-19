#!/usr/bin/env bash
set -e

# Bootstrap local development: preflight, env, and infra.
# Step output goes to .dev-up.log — check it on failure.

LOG=".dev-up.log"
: > "$LOG"

log() { echo "[lattik] $*"; }

step() {
  local label="$1"
  shift
  log "$label"
  if ! "$@" >> "$LOG" 2>&1; then
    echo "  failed — see .dev-up.log"
    exit 1
  fi
}

step "check-deps" node scripts/preflight.mjs

log "init-env"
if [ ! -f apps/web/.env ] || [ ! -f apps/agent-worker/.env ]; then
  node scripts/bootstrap-env.mjs
fi

# Register portless static route for the web dev server. We run `next dev`
# on a fixed port (3737) rather than letting portless assign an ephemeral
# one, so Gitea webhooks delivered from inside kind can reach the host at
# a stable host.docker.internal:3737 (see k8s/gitea-init.yaml).
if command -v portless >/dev/null 2>&1; then
  step "portless-alias" portless alias lattik-studio 3737 --force
fi

step "cluster" pnpm --silent cluster:up
step "postgres" pnpm --silent db:start
step "schema" pnpm --silent db:push
step "seed" pnpm --silent db:seed
step "worker" pnpm --silent worker:bootstrap

log "ready"
