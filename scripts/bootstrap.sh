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

step "cluster" pnpm --silent cluster:up
step "postgres" pnpm --silent db:start
step "schema" pnpm --silent db:push
step "seed" pnpm --silent db:seed

log "ready"
