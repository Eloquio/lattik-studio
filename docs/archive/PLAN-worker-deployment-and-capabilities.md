# Plan: Worker Deployment in Kind + Task Capability Model

> **2026-04-22 update:** Capabilities (per-task grants + per-agent ceilings) were dropped after this plan landed — permission now lives on the skill's `tools` list, not on a separate capability string. Heartbeat, stale-claim release, worker deployment, and the deterministic webhook path are all unchanged and still in force. Treat the capability-specific prose below as historical. See [PLAN-skill-based-worker-loop.md](PLAN-skill-based-worker-loop.md) for the current model.

**Goal:** Run `apps/agent-worker` as a Deployment inside the local kind cluster, managed from the Lattik Studio UI. Each task carries a capability list assigned by its planner and enforced by the agent SDK. Webhook-initiated requests skip planning and human approval via a hardcoded skill mapping.

**Scope:** Local dev. Prod-grade network isolation (NetworkPolicy + egress proxy), multi-cluster studio deployment, and public worker distribution are explicitly out of scope — noted where they'd slot in later.

---

## Context

### What already works

- `worker` table: `id` (primary key, caller-supplied), `name` (display), `token_hash` (sha256 of the bearer secret), `created_at` / `updated_at` (both `timestamp NOT NULL DEFAULT now()`; `updated_at` bumps on secret rotation) ([apps/web/src/db/schema.ts:149-158](apps/web/src/db/schema.ts#L149-L158)).
- `registerWorker({id, name})` mints a 32-byte hex secret, stores `sha256(secret)` in `token_hash`, returns plaintext once ([apps/web/src/lib/worker-tokens.ts:33-58](apps/web/src/lib/worker-tokens.ts#L33-L58)).
- `pnpm worker:bootstrap` auto-registers `local-dev-worker` and writes creds into `apps/agent-worker/.env`. **This command and the corresponding step in [scripts/bootstrap.sh](scripts/bootstrap.sh) are removed in this plan** — studio becomes the sole entry point for creating workers.
- Worker auth: `Authorization: Bearer <id>:<secret>` → `verifyWorkerToken` → `requireWorkerAuth` ([apps/web/src/lib/bearer-auth.ts:67-79](apps/web/src/lib/bearer-auth.ts#L67-L79)).
- Request/task two-tier queue with atomic `FOR UPDATE SKIP LOCKED` claim ([apps/web/src/lib/task-queue.ts](apps/web/src/lib/task-queue.ts)).
- `skills.auto_approve` flag already exists.

### What's missing

1. No kind deployment for agent-worker — no image, no manifest, no studio-side management.
2. No way for a kind pod to reach the studio on the host (port 3737).
3. No liveness signal — studio can't tell whether a worker is alive.
4. No stale-claim release on requests (tasks already have it).
5. No capability model — an agent can touch anything the worker pod can touch.
6. Webhooks always invoke the planner even though the event type is deterministic.

---

## User Story

*A developer runs `pnpm dev:up` on a fresh clone.*

1. Infra comes up (postgres, kafka, trino, airflow, etc.). Studio starts on the host at `https://lattik-studio.dev` (port 3737 under the hood). **No workers exist yet** — `pnpm dev:up` no longer creates one.
2. Dev opens **Settings → Workers → Add Worker**. Types a name, picks **"Deploy to cluster"** (default) or **"Run on host"**. Clicks create.
3. Studio mints credentials. For "Deploy to cluster" it writes a k8s Secret and applies a Deployment into the `workers` namespace; the pod starts, polls the claim endpoints, updates `last_seen_at`, and the row turns green within 5s. For "Run on host" it shows the secret + env block exactly once; dev pastes into `apps/agent-worker/.env`, runs `pnpm --filter agent-worker dev`, and the row turns green on first heartbeat. No k8s apply in that case.
4. Dev sends a chat request. The planner claims it, decomposes into tasks, assigns `capabilities` per task (each a subset of the target agent's ceiling), and persists. Human approves. The worker claims tasks one at a time and executes them.
5. A gitea PR is merged. The webhook handler matches the event type to a hardcoded skill, opens a transaction, inserts the request at `"approved"`, and fans out tasks in the same transaction. No planner, no approval dialog — tasks are immediately claimable.
6. Dev clicks **Revoke** on the worker row. Studio deletes the Deployment, Secret, and DB row; the pod disappears within a second.

---

## Design

### Worker identity

- `worker.id` is a **server-generated UUID**. Never derived from the `name`, so renames don't cascade into k8s object names, bearer tokens, or `task.claimed_by` history.
- `worker.name` is a free-form display string, **editable after creation**. A `renameWorker(id, name)` server action bumps `updated_at` via the existing `onConflictDoUpdate` path in `registerWorker` (callable with the same id but a new name; leaves the token hash alone if we split that out). UI offers an inline rename on the row.
- K8s object names derive from the UUID: Deployment `agent-worker-<uuid>`, Secret `agent-worker-<uuid>-creds`. UUIDs are 36 chars; with the 13-char prefix that's 49 chars, well under k8s's 63-char pod-name limit.

### Deployment layout

- New namespace **`workers`**. Isolated from `workloads` (which is for Spark driver/executor pods) so long-lived worker Deployments don't mix with ephemeral job pods.
- Image **`lattik/agent-worker:dev`**, built from [`k8s/agent-worker/Dockerfile`](k8s/agent-worker/Dockerfile). `node:24-alpine` + the agent-worker source, `kind load`ed into the cluster. Build context is the monorepo root so pnpm workspace deps resolve.
- Manifest [`k8s/agent-worker.yaml`](k8s/agent-worker.yaml) — namespace, Deployment template (parameterized by worker id + secret name), placeholder Secret. Studio fills in the worker-specific values before apply.
- One Deployment per worker (name: `agent-worker-<worker.id>`), `replicas: 1`, `strategy: Recreate` — one identity, one process.

### Reaching the host from a kind pod

- `TASK_API_URL=http://host.docker.internal:3737` baked into the pod env.
- Works on **Docker Desktop for Mac**; Linux kind needs an explicit `hostAliases` entry to the host gateway. Document this in the worker readme but don't solve it — team is on Mac.
- Skip TLS entirely — local dev, traffic stays inside the Docker network.

### Studio owns the worker lifecycle

Studio needs cluster-write capability. Mechanics:

- **`/settings/workers`** — table with name, id, live-pill (green ≤30s since last heartbeat, else grey), mode (cluster/host), created_at, **Revoke** button.
- **"Add Worker"** modal — name input + mode toggle (**Deploy to cluster** default, or **Run on host**). Server action branches on mode:
  - **Deploy to cluster:**
    1. `registerWorker({id, name})` — DB row + secret.
    2. `kubectl apply` the Secret (`LATTIK_WORKER_ID`, `LATTIK_WORKER_SECRET`) into `workers` ns.
    3. `kubectl apply` a Deployment for this worker, pointing at that Secret via `envFrom`.
    4. Return. UI polls `last_seen_at` and flips the pill to green when fresh.
  - **Run on host:**
    1. `registerWorker({id, name})` — DB row + secret.
    2. Return the secret + recommended env block to the client. The modal displays them exactly once with a copy button; closing the modal loses the secret (same contract as `registerWorker` itself).
    3. Dev pastes into `apps/agent-worker/.env` and runs `pnpm --filter agent-worker dev`. UI polls `last_seen_at` the same way and turns the pill green on the first heartbeat.
    - No k8s apply. The `worker` row is tagged `mode: "host"` so Revoke knows not to try deleting cluster objects.
- **Revoke** — deletes the Deployment + Secret (if cluster mode) + `worker` row. Pod goes away; any in-flight claim gets released by the stale-claim cron. For host-mode workers, Revoke just deletes the DB row; the host process will 401 on its next poll and can be Ctrl-C'd.

Cluster access: studio uses `~/.kube/config` during local dev (it runs on the host, so the host's kubeconfig is available). A thin wrapper at **`apps/web/src/lib/kube.ts`** abstracts the k8s client so it can later swap to an in-cluster ServiceAccount when studio itself is deployed somewhere.

### Studio → cluster deploy mechanics

Concrete answers to the sub-problems baked into "studio owns the worker lifecycle":

- **Client: shell out to `kubectl`.** `kubectl` is already a dev prereq and every other piece of cluster tooling in this repo shells out to it (see `scripts/*.sh` and the `*:start` scripts). No new npm dep, no OpenAPI client to wrangle. `lib/kube.ts` uses `execa` (or `child_process`) to pipe a generated manifest to `kubectl apply -f -`. When studio later runs off-host, swap the implementation to [`@kubernetes/client-node`](https://github.com/kubernetes-client/javascript) — contained to one file.
- **Manifest generation: TS template literals, no separate YAML template.** `lib/kube.ts` exports `buildWorkerManifests({ workerId, name, secret })` returning a single YAML string containing the Secret + Deployment for that worker. Per-worker values are injected at build time; no regex replacement, no `k8s/agent-worker.yaml` template sitting on disk. (The `Dockerfile` stays on disk — it's only the runtime manifest that lives in TS.)
- **Partial-failure handling: idempotent create + best-effort rollback.** For `mode: "cluster"`, `createWorker` runs: (1) DB insert with `mode: "cluster"` + mint secret in a transaction, (2) `kubectl apply` Secret, (3) `kubectl apply` Deployment. If (2) or (3) fails, catch and best-effort delete whatever got applied (Deployment, Secret, DB row), then surface the error. For `mode: "host"`, only step (1) runs — nothing to roll back beyond the DB row if the response fails to reach the client (the dev just creates another and discards the stray row via Revoke). No `worker.status` column — the signals are: "DB row exists" = registered, "`last_seen_at` fresh" = healthy, "DB row old with null `last_seen_at`" = deployment failed (cluster) or never started (host).
- **Readiness polling: `last_seen_at` is the only signal.** After `createWorker` returns, the UI shows a grey row labelled "starting…". Client polls `listWorkers()` every 2s; the pill flips green the moment `last_seen_at` shows up and is fresh. No k8s-API poll, no SSE — same signal the live pill already needs, reused.
- **Namespace lifecycle: created at cluster-up.** [k8s/namespaces.yaml](k8s/namespaces.yaml) (applied by `pnpm cluster:up`) includes `workers`, so the namespace always exists before `createWorker` runs. Document that invariant as a one-liner comment on `createWorker` so "ns missing" can't silently become a failure mode.

### Liveness via heartbeat

- Add `worker.last_seen_at timestamptz`.
- Both claim endpoints update `last_seen_at = now()` after auth, whether or not anything got claimed.
- Threshold: **30s** (6× the 5s poll interval; tolerates transient flakes).
- `countActiveWorkers()` returns the count of workers with `last_seen_at > now() - interval '30 seconds'`. Feeds the Requests sidebar badge and the Workers page pill.

### Stale-claim release on requests

Mirror the existing task-level pattern:

- Add `request.stale_at timestamptz`.
- Set `stale_at = now() + interval '10 minutes'` on successful request claim.
- Extend `/api/cron/process-tasks` with a reset pass:
  ```sql
  UPDATE request
  SET status='pending', claimed_by=NULL, stale_at=NULL
  WHERE status='planning' AND stale_at < now();
  ```
- Extension endpoint deferred — 10 min default is fine for dev.

### Task capability model

Core shape:
- **`agent.allowed_capabilities text[]`** — ceiling per agent. Static, set at agent definition time.
- **`task.capabilities text[]`** — per-task grant. Emitted by the planner (or by a skill recipe for webhook-driven requests).
- **Invariant** (enforced server-side at task insertion): `task.capabilities ⊆ agent.allowed_capabilities` for the task's `agent_id`. Rejecting violations at insert time means the DB can't contain a task with an over-broad grant.

Enforcement (dev):
- Worker pod has full network access. No NetworkPolicy, no egress proxy.
- Agent SDK exposes `ctx.capabilities: string[]` and `ctx.requireCapability(cap)` which throws if the capability isn't on the task. Library code that touches Kafka, S3, Trino, etc. calls `requireCapability` first.
- A buggy or malicious agent could bypass the SDK and hit resources directly — acceptable for local dev.

Enforcement (prod, deferred):
- Same `task.capabilities` column, no data-model change needed.
- Add an **in-pod egress proxy** with short-lived per-task tokens scoped to the task's allowed hosts. Agent network calls route through the proxy; raw `fetch` to disallowed hosts is refused at the network layer.
- Add **NetworkPolicy** on the worker pods so default-deny egress applies.

Capability vocabulary (initial set; opaque strings, no central enum):
`kafka:read`, `kafka:write`, `s3:read`, `s3:write`, `trino:query`, `iceberg:ddl`, `postgres:read`, `llm:invoke`.

### Deterministic webhook handling

Webhook-initiated requests bypass the planner and human approval, because the event type uniquely determines how to handle it.

- Webhook handler does a **hardcoded switch** on event type → skill id. Start simple; generalize to a `webhook_source` table only when a second webhook source shows up.
- Unknown event types: return 400 + log. Don't create a `skill_id: null` orphan.
- Known event types, in a single DB transaction:
  1. Insert `request` with `source: "webhook"`, `skill_id`, `status: "approved"` (skipping `pending` / `planning` / `awaiting_approval`).
  2. `applySkillRecipe(requestId, skillId, context)` — reads the skill definition, generates task rows parameterized by `context`, each with its declared `capabilities` (validated subset of the target agent's ceiling), inserted at `status: "pending"`.
  3. Commit.
- Atomicity matters: a `createRequest` commit without `applySkillRecipe` would leave an `"approved"` request with no tasks — a zombie. Either wrap both in a transaction or keep the request at `"pending"` until the recipe succeeds and then flip.

Skills bound to webhooks must be **pure data recipes** — templates, not LLM-driven. The recipe carries: task structure, target agent ids, capability lists. No LLM in the hot path.

---

## Schema changes

```sql
-- liveness
ALTER TABLE worker ADD COLUMN last_seen_at timestamptz;
CREATE INDEX idx_worker_last_seen_at ON worker (last_seen_at);

-- worker mode: "cluster" (deployed to kind) or "host" (running on dev machine)
ALTER TABLE worker ADD COLUMN mode text NOT NULL DEFAULT 'cluster';

-- stale-claim release on requests
ALTER TABLE request ADD COLUMN stale_at timestamptz;
CREATE INDEX idx_request_stale_at ON request (stale_at) WHERE status = 'planning';

-- capability model
ALTER TABLE agent ADD COLUMN allowed_capabilities text[] NOT NULL DEFAULT '{}';
ALTER TABLE task  ADD COLUMN capabilities         text[] NOT NULL DEFAULT '{}';
```

Drizzle-side: update [apps/web/src/db/schema.ts](apps/web/src/db/schema.ts), then `pnpm db:push`.

---

## Server-side changes

| Surface | Change |
|---|---|
| [apps/web/src/app/api/tasks/claim/route.ts](apps/web/src/app/api/tasks/claim/route.ts) | Touch `worker.last_seen_at = now()` after auth. Return `capabilities` on the claimed task. |
| [apps/web/src/app/api/tasks/requests/claim/route.ts](apps/web/src/app/api/tasks/requests/claim/route.ts) | Same heartbeat. Set `request.stale_at = now() + 10 min` on successful claim. |
| `/api/cron/process-tasks` | Add request-stale reset pass (see SQL above). |
| [apps/web/src/app/api/webhooks/gitea/route.ts](apps/web/src/app/api/webhooks/gitea/route.ts) | Hardcoded event → skill mapping. Transactional `createRequest` + `applySkillRecipe`. Status jumps to `"approved"`. Skip planner + approval. |
| `createRequest` | Accept optional `skillId`, `status`, and a synchronous recipe path. |
| `applySkillRecipe(requestId, skillId, context)` (new) | Reads skill def, emits tasks, validates `capabilities ⊆ agent.allowed_capabilities`, inserts at `"pending"`. |
| Task-insertion path (planner and recipe) | Enforce the capability-subset invariant server-side. |
| `countActiveWorkers()` | Rewrite: count workers with fresh `last_seen_at`. |
| `listWorkers()`, `createWorker({ name, mode })`, `renameWorker(id, name)`, `revokeWorker(id)` (server actions) | `createWorker` generates a UUID for `id`, inserts the DB row with `mode`. For `mode: "cluster"` it also applies Secret + Deployment. For `mode: "host"` it returns the secret + env block to the client (shown once). `renameWorker` updates `name` + bumps `updated_at` (no token rotation). `revokeWorker` deletes DB row + (if cluster) Deployment + Secret. |
| [apps/web/src/lib/kube.ts](apps/web/src/lib/kube.ts) (new) | Thin wrapper over the k8s client / `kubectl` invocations. |

---

## Worker-side changes

- [apps/agent-worker/src/task-client.ts](apps/agent-worker/src/task-client.ts) — no change. Already reads `TASK_API_URL` / `LATTIK_WORKER_ID` / `LATTIK_WORKER_SECRET` and sends the bearer header. The same code runs unchanged inside kind.
- `apps/agent-worker/src/agent-context.ts` (new) — exposes `ctx.capabilities` and `ctx.requireCapability(cap)` to agent code. Populated from each claimed task's `capabilities` field.
- `pnpm --filter agent-worker dev` still runs the worker host-side. It's no longer a "fallback" — it's the normal path for iterating on worker code, driven by a `mode: "host"` worker created from studio. The dev pastes the studio-shown secret into `apps/agent-worker/.env` once per created host-worker and starts the process; rotation = revoke + create again.
- Claim contention: two workers (one cluster, one host) with different identities will both poll and race for claims. Fine for dev — tasks just get distributed. To force all traffic to the host worker while debugging, revoke the cluster worker.

---

## UI changes

- New page **`/settings/workers`** — table + Add Worker modal + inline rename + Revoke.
- **Requests sidebar** — "N workers online" badge reading from `countActiveWorkers()`.
- **Request detail** — `claimed_by` rendered as worker name (join on `worker.name`), not raw id. Each task's `capabilities` shown as chips. If a request is stale, a countdown.

---

## Build + scripts

| New | What |
|---|---|
| [k8s/agent-worker/Dockerfile](k8s/agent-worker/Dockerfile) | `node:24-alpine`, install from the monorepo root, `CMD ["pnpm", "--filter", "agent-worker", "start"]`. |
| [k8s/agent-worker.yaml](k8s/agent-worker.yaml) | Namespace ref + Deployment template + placeholder Secret schema. |
| [k8s/namespaces.yaml](k8s/namespaces.yaml) | Add `workers` namespace. |
| `pnpm worker:image-build` | `docker build` + `kind load`. |
| `pnpm worker:logs <id>` | `kubectl logs -n workers deployment/agent-worker-<id> -f`. |

Wire `worker:image-build` into `images:build`. **No** `worker:start` in `dev:services` — workers are created from the studio UI, not from scripts. `pnpm worker:bootstrap` is **removed**, along with its call site in [scripts/bootstrap.sh](scripts/bootstrap.sh). After `pnpm dev:up`, there are zero workers; the dev creates the first one from **Settings → Workers**.

---

## Implementation phases

Each phase ships independently.

### Phase 1 — Heartbeat + stale-claim release (server only)
Schema columns (including `worker.mode`), claim-route updates, cron pass, `countActiveWorkers()` rewrite. No UI yet. Since `pnpm worker:bootstrap` is gone, verification uses a throwaway `tsx` script that invokes `registerWorker` directly to mint creds, then points a host-run `agent-worker` at them. Watch `SELECT last_seen_at FROM worker;` tick every 5s; confirm the sidebar badge flips to "0 workers online" 30s after stopping. The throwaway script is deleted in Phase 5 once the studio UI covers the same flow.

### Phase 2 — Capability model
Add `agent.allowed_capabilities` + `task.capabilities`. Return `capabilities` on claim. Enforce subset on task insert. Land `ctx.requireCapability` in the agent SDK (no call sites yet). Back-fill `allowed_capabilities` for existing agents as a one-time script. Verified via unit tests + targeted seed data.

### Phase 3 — Deterministic webhook path
Hardcoded event → skill mapping in [apps/web/src/app/api/webhooks/gitea/route.ts](apps/web/src/app/api/webhooks/gitea/route.ts). Transactional fan-out. Verified by pushing a test PR to Gitea and observing: request at `"approved"`, tasks at `"pending"`, no planner involvement in the logs.

### Phase 4 — Worker image + manifest
Dockerfile, agent-worker.yaml (with placeholders), `worker:image-build`. Verified manually: `kubectl create secret ... && kubectl apply -f k8s/agent-worker.yaml` → pod Running, `last_seen_at` ticking.

### Phase 5 — Studio-managed workers
`/settings/workers` page + `createWorker` / `revokeWorker` server actions + `lib/kube.ts`. Verified end-to-end: click Add Worker → pod appears → pill turns green → Revoke → pod disappears.

### Phase 6 — End-to-end auth + capability verification
Submit a human request that produces tasks with varying capabilities. Confirm the worker executes successfully; confirm agent code without the right capability throws as expected. Revoke a worker; confirm its old secret 401s; recreate and confirm the new credentials work.

---

## Open questions

1. **Cluster access from studio when studio leaves the host.** Local dev uses host kubeconfig; once studio is deployed non-cluster, it needs an alternative (dedicated bastion API, or studio itself runs in-cluster with a ServiceAccount). Out of scope here.
2. **Worker pod resource limits.** Default proposal: `requests.memory=256Mi`, `limits.memory=1Gi`, `requests.cpu=100m`. Tune once we observe OOMs.
3. **Capability back-fill.** What gets `allowed_capabilities` on existing agents? Proposal: audit each agent, assign explicitly. Blocks Phase 2 close-out.
4. **Skill recipe representation.** JSON, TS function, pointer to module? Proposal: TS function in a registry keyed by skill id (skills are code, and recipes can reference typed context). Lock in before Phase 3.
5. **Egress proxy design.** Not in this plan. Shape: a per-pod sidecar or init-container proxy with a capability-scoped token minted per task. Revisit when we have at least one agent that warrants prod-grade isolation.
6. **Image rebuild friction.** Every change to `apps/agent-worker/src` requires `worker:image-build`. A `hostPath`-mounted dev mode would skip rebuilds but complicates the manifest. Defer — the host-run fallback covers tight loops.
