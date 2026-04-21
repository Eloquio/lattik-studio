# Lattik agent-worker image.
#
# Build context: the monorepo root (not apps/agent-worker/). We need the
# root lockfile + pnpm-workspace.yaml so pnpm can resolve the workspace.
#
#   docker build -t lattik/agent-worker:dev -f k8s/agent-worker/Dockerfile .
#
# Single-stage on node:24-alpine. tsx is a devDependency so we install with
# --prod=false; the image stays ~150 MB because alpine + tree-shaken deps.
# No compile step — tsx runs the TypeScript directly at boot.

FROM node:24-alpine

RUN corepack enable pnpm

WORKDIR /app

# Copy the workspace manifests first so `pnpm install` can be cached until
# any of them actually change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json

RUN pnpm install --filter agent-worker... --frozen-lockfile --prod=false

# Now copy the source. Changes here bust only the source layer, not the deps.
COPY apps/agent-worker/tsconfig.json apps/agent-worker/tsconfig.json
COPY apps/agent-worker/src apps/agent-worker/src

WORKDIR /app/apps/agent-worker

# Invoke tsx directly rather than `pnpm start` — the package.json script
# passes `--env-file=.env` which would fail here (no .env in the image).
# Env vars come from the pod spec via envFrom: Secret/ConfigMap refs.
CMD ["node_modules/.bin/tsx", "--use-system-ca", "src/index.ts"]
