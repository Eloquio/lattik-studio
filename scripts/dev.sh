#!/usr/bin/env bash
set -e

# Start services (background) and dev server (foreground).

echo "[lattik] services"
pnpm --silent dev:services > .dev-services.log 2>&1 &

echo "[lattik] dev"
exec pnpm --silent dev:web
