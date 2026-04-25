# Plan: Improve Local Setup Experience

**Goal:** Reduce friction and time-to-first-screen for users testing Lattik on their laptop.

**Current state:** Setup requires 6 prerequisites, ~8 manual steps, and 10-20 minutes on first run. There are no preflight checks, no health verification, no system requirements documented, and no troubleshooting guide. The root README and lattik-studio README describe different flows.

---

## Pain Points (ranked by user impact)

### P0 — Users get stuck or silently fail

| # | Problem | Evidence |
|---|---------|----------|
| 1 | No preflight checks — users discover missing tools (Docker, kind, helm, Node 22+, pnpm 10+) mid-setup, often after waiting minutes | `cluster:up` just runs `kind create cluster` and fails cryptically if kind isn't installed |
| 2 | System requirements undocumented — kind + all services need ~8-12 GB RAM, ~50 GB disk; users on 8 GB machines hit OOM kills silently | Nothing in either README mentions hardware requirements |
| 3 | No health check — after `pnpm dev`, no way to verify all services are actually running | Users must manually `tail -f .dev-services.log` and eyeball it |
| 4 | `sudo portless proxy start --tld dev` surprises users — requires privilege escalation with no explanation of why | Root README shows `sudo`; studio README omits it but it still requires it for port 443 |

### P1 — Confusing or slow

| # | Problem | Evidence |
|---|---------|----------|
| 5 | Two divergent READMEs — root README has a streamlined 6-step flow; lattik-studio README has an 8-step flow with a manual Gitea token copy step that is actually automated by `sync-gitea-token.mjs` | Root README: `pnpm dev:up` then `pnpm dev`. Studio README: manual `cluster:up`, `db:start`, `db:push`, `db:seed`, then separate `gitea:start` + copy token |
| 6 | First run time understated — "a few minutes" is actually 10-20 minutes (image builds, helm installs, pod scheduling) | No progress indicator or phase-by-phase time estimates |
| 7 | No troubleshooting guide — common failures (port conflicts, Docker not running, OOM, stale cluster) have no documented fixes | Users must read k8s manifests and debug kubectl output themselves |

### P2 — Polish

| # | Problem | Evidence |
|---|---------|----------|
| 8 | `print-next-steps.mjs` exists but is never called from any script | Dead code — could be wired into `dev:up` |
| 9 | AI Gateway key skip creates a silent failure mode — chat looks ready but agent calls fail | Bootstrap warns in terminal but user may miss it by the time they open the browser |

---

## Approved Changes

### 1. Add a preflight check script (`scripts/preflight.mjs`) ✓

Run automatically at the start of `dev:up` (before `env:bootstrap`). Checks:

- [ ] Docker daemon is running (`docker info`)
- [ ] `kind` is installed and meets minimum version
- [ ] `helm` is installed
- [ ] `kubectl` is installed
- [ ] Node.js >= 22 (`process.version`)
- [ ] pnpm >= 10 (`pnpm --version`)
- [ ] `portless` is installed globally
- [ ] Available RAM >= 8 GB (warn if < 12 GB)
- [ ] Available disk space >= 20 GB
- [ ] Key ports are free: 443, 3300, 3737, 5432, 8080, 8088, 9000, 9001, 9094

Output: a clear checklist with pass/fail per item. Abort on any hard failure with a one-line fix suggestion (e.g., `brew install kind`). Warn on soft failures (low RAM, missing portless).

### 2. Add a health check command (`pnpm dev:status`) ✓

A standalone command users can run anytime to check which services are up/down:

```
  Service            Status    Endpoint
  ─────────────────  ────────  ─────────────────────────────
  kind cluster       ✓ ready   (lattik)
  PostgreSQL         ✓ ready   localhost:5432
  Next.js dev        ✓ ready   https://lattik-studio.dev
  Gitea              ✓ ready   http://localhost:3300
  Trino              ✓ ready   http://localhost:8080
  MinIO              ✓ ready   http://localhost:9000
  Kafka              ✓ ready   localhost:9094
  Schema Registry    ✓ ready   http://localhost:8081
  Spark Operator     ✓ ready   (spark-operator ns)
  Airflow            ✓ ready   http://localhost:8088
  portless proxy     ✗ not running  (run: sudo portless proxy start --tld dev)
```

Implement as `scripts/dev-status.mjs` using `kubectl get pods` per namespace + TCP port probes for host-exposed services.

### 3. Consolidate READMEs and restructure setup flow ✓

**Root README (`/README.md`)** — single canonical setup guide. The new setup is 4 commands:

```bash
# Start the portless HTTPS proxy (requires sudo for port 443)
sudo portless proxy start --tld dev

cd lattik/lattik-studio
pnpm install
pnpm dev:up
```

**`pnpm dev:up` becomes the single entry point** that does everything:
1. Run preflight checks
2. Run `env:bootstrap` (prompt for AI Gateway key, generate secrets)
3. Start required services: kind cluster → Postgres → DB schema push → seed
4. Start Next.js dev server (foreground — serves at https://lattik-studio.dev)
5. Start remaining services in background (image builds, Gitea, Trino, Kafka, Schema Registry, Ingest, Spark, Airflow) — progress logged to `.dev-services.log`

**Service grouping:**
- **Required (before web starts):** kind cluster, PostgreSQL, DB schema + seed
- **Background (after web is serving):** Gitea, Trino + MinIO + Iceberg REST, Kafka, Schema Registry, Ingest, Spark Operator, Airflow

**lattik-studio README** — remove duplicate Getting Started. Replace with pointer to root README.

### 4. Wire `print-next-steps.mjs` into `dev:up` ✓

Currently dead code. Run at the end of the "required services" phase (after DB seed, before starting the web server) so users see guidance while the web boots.

---

## Rejected

- ~~**5. `dev:services` progress output**~~ — rejected
- ~~**6. Troubleshooting section in README**~~ — rejected

---

## Implementation Order

1. **Preflight script** (`scripts/preflight.mjs`)
2. **Restructure `dev:up`** — merge `dev.sh` logic so it runs preflight → env → required services → print-next-steps → web (foreground) + background services
3. **Health check** (`scripts/dev-status.mjs` + `pnpm dev:status`)
4. **README consolidation** — rewrite root README setup, remove studio README duplicate

---

## Out of Scope (for now)

- **Pre-built Docker images** — publishing to a registry would skip local image builds (~5 min savings) but requires CI/CD and registry setup. Revisit once the contributor base grows.
- **Devcontainer / Codespaces support** — would eliminate all local prereqs but is a separate project.
- **CI-friendly setup** (no `sudo`, no portless) — would need an HTTP-only auth mode. Separate effort.
- **Minimum-viable setup mode** — a `pnpm dev --minimal` that only starts cluster + postgres + web (skip Trino, Kafka, Airflow, Spark). The `CLAUDE.md` already hints at this (`pnpm cluster:up && pnpm db:start && pnpm db:push`) but it's not a named command. Could formalize later.
