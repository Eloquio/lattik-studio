#!/usr/bin/env bash
# Materialize the `gitea-webhook-config` Kubernetes Secret from the host's
# apps/web/.env so the gitea-init Job can register a webhook with the same
# HMAC secret the Next.js route verifies against.
set -euo pipefail

ENV_FILE="apps/web/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Run 'pnpm dev:bootstrap' first." >&2
  exit 1
fi

SECRET=$(grep '^GITEA_WEBHOOK_SECRET=' "$ENV_FILE" | head -n1 | cut -d= -f2-)

if [ -z "${SECRET:-}" ]; then
  echo "ERROR: GITEA_WEBHOOK_SECRET is empty in $ENV_FILE." >&2
  echo "       Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

kubectl -n gitea create secret generic gitea-webhook-config \
  --from-literal=GITEA_WEBHOOK_SECRET="$SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
