# Plan: Self-Hosted Workers

**Goal:** Let a user run a Lattik worker on their own hardware (e.g. a Mac Mini in their living room), connect it to a Lattik Studio account, and have it execute agent requests end-to-end — with clear visibility into whether the worker is alive and whether in-flight claims are making progress.

**Scope:** Self-hosted only. Cloud-dispatched workers (Vercel Sandbox, etc.) are out of scope for this doc.

---

## Context

### Where we are today

- A `worker` table exists with `id`, `name`, `token_hash`, timestamps.
- Workers authenticate per-process with `Authorization: Bearer <workerId>:<secret>`; the studio stores `sha256(secret)` and compares at request time.
- Workers are **fungible**: no per-worker agent list. The agent role is a property of the request (`request.agent_id`) — when a worker claims a request, the agent it instantiates is dictated by that column. If `agent_id` is null, the worker runs as the planner and decides.
- Claims are atomic: `claimRequest(workerId)` does `UPDATE request SET status='planning', claimed_by=$1 WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`. Two workers can't walk away with the same request.
- A local-dev worker is registered automatically by `pnpm worker:bootstrap` and its credentials are written to `apps/agent-worker/.env`.

### What's missing for real self-hosted use

1. **Liveness.** A worker that crashes, loses network, or gets unplugged is indistinguishable from an idle healthy one. We can't answer "is the Mini alive?" or "how many workers are running right now?"
2. **Stale-claim release on requests.** If a worker claims a request and then dies, the request stays locked forever. Tasks have `stale_at` + a reset path; requests don't.
3. **Registration UX.** Minting a worker token today requires running a script inside the monorepo. A real user needs a studio-side UI to create a worker, see its secret once, and copy it into their Mini.
4. **Distribution.** `apps/agent-worker` is a pnpm workspace package inside this monorepo. A real user needs an installable artifact — not a git clone.
5. **Connectivity assumptions.** The Mini is behind NAT in someone's house. We need outbound-only comms (studio cannot push); our polling model already satisfies this but we should make it explicit.

---

## User Story

*Maria has a Mac Mini gathering dust in her home office. She wants to turn it into a Lattik worker so her data-lake jobs run on hardware she owns.*

1. Maria opens Lattik Studio → **Settings → Workers → Add worker**.
2. She types a name ("Mini in the office"). Studio generates a token, shows it **once**, and displays an install command.
3. On the Mini, she installs the Lattik worker (`brew install lattik-worker` / `docker run …` / TBD — see Open Questions).
4. She pastes the token into an env var and starts the worker.
5. Back in Studio, the worker row goes green with "last seen 2s ago" within one poll cycle.
6. When a request lands that Maria's worker can handle, the worker picks it up, executes it, and marks it done. Studio shows the request's `claimed_by` as "Mini in the office".
7. Maria reboots the Mini. Studio shows the worker grey after 30s. Any request it had in-flight gets unlocked after its stale timeout and another worker (or the rebooted Mini once back online) picks it up.

---

## Design

### Liveness via heartbeat

Add a `last_seen_at` timestamp to `worker`. Workers update it on **every** poll of `/api/tasks/requests/claim` (not a separate heartbeat endpoint — folding the signal into an existing request avoids an extra RPC). A worker is considered **live** if `last_seen_at > now() - <threshold>`.

- **Threshold:** 30s default (6× the 5s poll interval, accommodates transient network hiccups).
- **`countActiveWorkers()`** returns the count of workers with a fresh `last_seen_at`, honestly this time — this is what the earlier Requests panel tried to surface.
- **UI:** the studio Workers page renders a green/grey dot per worker with "last seen Xs ago". The Requests sidebar gets the honest "N workers online" badge.

### Stale-claim release on requests

Mirror the existing task-level pattern:

- Add `stale_at` timestamp to `request`, set atomically during claim to `now() + <stale_timeout>`.
- Add a reset path — either a dedicated cron, or folded into the existing `/api/cron/process-tasks` phase: `UPDATE request SET status='pending', claimed_by=NULL, stale_at=NULL WHERE status='planning' AND stale_at < now()`.
- **Stale timeout for requests:** default 10 minutes. Configurable per-request via `request.stale_timeout_ms` if we find planning legitimately takes longer for some flows.
- **Worker responsibility:** workers must complete *or* explicitly extend the claim. An extension endpoint (`POST /api/tasks/requests/:id/extend`) pushes `stale_at` forward by the configured timeout. The worker calls this if it knows it's still alive but the planning/execution is taking a while.

### Registration UX

A new Studio page: `/settings/workers` (server-rendered).

**Listing:** one row per registered worker — name, id, `last_seen_at` pill (live/grey), created date, **Revoke** button.

**Create flow:**
1. Click "Add worker", type a name.
2. Server creates the `worker` row, calls `registerWorker({id, name})`, receives the plaintext secret.
3. Studio displays a modal with the command block for the user to copy (install command + env exports). The secret is visible **once** — closing the modal loses it. If the user didn't copy it, they revoke and create again.

The create action calls a server action `createWorker(name: string)`; no new HTTP endpoint needed.

### Distribution — **Open Question**, pick one

- **Option A — Docker image.** `lattik/worker:latest`. `docker run -e LATTIK_WORKER_ID=... -e LATTIK_WORKER_SECRET=... -e TASK_API_URL=... lattik/worker`. Easy to ship to any OS; every agent's deps (kafkajs, aws-sdk, spark clients if we go there) fit inside one image. Cost: the user has to run Docker, which on a Mini means Colima/Docker Desktop.
- **Option B — npm package.** `npm i -g @lattik/worker` → `lattik-worker start`. No container runtime needed. Node process bundles all agents. Cost: harder to sandbox; users have to manage Node versions; upgrades are manual.
- **Option C — Standalone binary.** Bundle node+sources with `pkg` or `bun build --compile`. Single download, no runtime dependency. Cost: binary per platform (darwin-arm64, darwin-x64, linux-*), CI pipeline to build and publish.

Recommendation: **A (Docker)** for v1. It sidesteps platform-specific packaging and gives us one install command that works identically on a Mac Mini, a Linux VM, or a NAS. Revisit (B)/(C) once we have signal on who actually uses this.

### Connectivity

- Outbound HTTPS to studio on 443 only. No inbound exposure. No need for a reverse tunnel.
- Worker polls `/api/tasks/requests/claim` every 5s (configurable). On claim, stops polling until the request is done or failed, then resumes.
- Studio URL is configured at install time via `TASK_API_URL` env var. For production users this is `https://studio.lattik.com`; for self-hosted studio deployments it can be their own URL.

### What the worker actually does after claiming a request

Already defined by the task queue:
- If `request.agent_id` is null → worker runs planning (skill-match, decomposition, or LLM planner).
- If `request.agent_id` is set → worker instantiates that agent and executes directly.

Planning produces tasks (existing `tasks` table). The same worker can execute those tasks or release them for other workers — TBD, see Open Questions.

---

## Schema Changes

```sql
-- worker: add heartbeat
ALTER TABLE worker ADD COLUMN last_seen_at timestamptz;
CREATE INDEX idx_worker_last_seen_at ON worker (last_seen_at);

-- request: add stale-claim release
ALTER TABLE request ADD COLUMN stale_at timestamptz;
ALTER TABLE request ADD COLUMN stale_timeout_ms integer;  -- override; null = default
CREATE INDEX idx_request_stale_at ON request (stale_at) WHERE status = 'planning';
```

No changes to `agent`, `task`, or the task-level claim flow.

---

## API / Server Action Changes

| Surface | Change |
|---|---|
| `POST /api/tasks/requests/claim` | Update `worker.last_seen_at = now()` on every call (claim or empty). Set `request.stale_at` on successful claim. |
| `POST /api/tasks/requests/:id/extend` | **New.** Worker pushes `stale_at` forward. Returns 404 if the worker doesn't own the claim. |
| `POST /api/tasks/requests/:id/complete` | **New** (if it doesn't exist yet for requests). Worker marks the request done; releases the claim. |
| `POST /api/tasks/requests/:id/fail` | **New** (same). Worker marks request failed with a reason. |
| Cron / planner loop | Add a "reset stale request claims" pass, mirroring the existing task-stale-reset. |
| `listAllWorkers()` server action | **New.** Reads the `worker` table and returns liveness derived from `last_seen_at`. |
| `createWorker(name)` server action | **New.** Inserts a `worker` row, mints a secret, returns it once. |
| `revokeWorker(id)` server action | Already exists in the lib — wire it to a server action. |
| `countActiveWorkers()` server action | **Replace** the earlier version to count by `last_seen_at` instead of claimed tasks. |

---

## UI Changes

- **New page:** `/settings/workers` — list, create modal, revoke.
- **Requests sidebar badge:** bring back the "N workers online" indicator, now honest.
- **Request detail:** show `claimed_by` as a worker name (resolved via join), not the raw id. Show `stale_at` countdown if the claim is still live.

---

## Implementation Phases

1. **Heartbeat + stale-claim release.** Schema change, claim-route updates, cron reset pass, honest `countActiveWorkers()`. No UI yet — this closes loops we already opened and is the foundation for the rest.
2. **Workers page + create/revoke flow.** UI for registration. Ships the product on-ramp; users can now register a worker without running scripts in the monorepo.
3. **Distribution.** Publish a Docker image (`lattik/worker`) with a GHA pipeline. Update docs. First public release.
4. **Polish.** Request detail shows worker name. Sidebar badge. Per-worker request history.

Each phase is shippable on its own.

---

## Open Questions

1. **Distribution format** — Docker vs npm vs binary (default Docker, see above).
2. **Worker ownership** — are workers scoped to a user (`owner_id`) or to a "team"/org? Today we don't have orgs. For v1, scope to the user who created them.
3. **Planning vs execution split** — when a worker claims a request with no agent assigned and planning produces 10 tasks, does *that* worker execute all 10, or release them for the task queue? Releasing is consistent with the existing model; keeping them lets a user run heavy work on their Mini without involving cloud workers. Start by releasing tasks; revisit if a use case needs affinity.
4. **Auto-upgrade** — when the studio schema moves, does the worker need to update? Include a `worker.version` field and let studio warn on mismatch; hard-fail only on incompatible majors.
5. **Rate limiting per worker** — should we cap how many requests a single worker can hold at once? Today: one at a time (claim one, finish, claim next). Cap = 1 implicit. Good enough for v1.
6. **Worker-side logging** — for debugging a crashing Mini, do we need logs to ship back to studio? Nice-to-have; not blocking.
7. **Self-hosted studio** — if a user runs both studio and worker on the same Mini, does anything change? No — worker still calls studio over HTTP(S); just over localhost. Document this as a valid topology.
