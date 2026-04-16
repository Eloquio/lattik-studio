#!/usr/bin/env bash
set -e

# Start services (background) and dev server (foreground).

echo "[lattik] services"
pnpm dev:services > .dev-services.log 2>&1 &

echo "[lattik] dev"
pnpm dev:web
