#!/usr/bin/env bash
set -e

# Start services (background) and dev server (foreground).

# Free port 3737 if a stale dev server is still bound to it.
if pids=$(lsof -ti :3737 2>/dev/null) && [ -n "$pids" ]; then
  echo "[lattik] port 3737 in use — killing $pids"
  kill -9 $pids 2>/dev/null || true
fi

echo "[lattik] services"
pnpm dev:services > .dev-services.log 2>&1 &

echo "[lattik] dev"
pnpm dev:web
