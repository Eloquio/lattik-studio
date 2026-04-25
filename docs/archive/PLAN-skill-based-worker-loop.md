# Plan: Skill-based Worker Loop

**Goal:** Consolidate the agent + handler model into a single concept — **skills**. Workers poll Requests (not Tasks), decide per-iteration whether to plan or execute, and dispatch by skill rather than by agent. This is the follow-up to [PLAN-worker-deployment-and-capabilities.md](PLAN-worker-deployment-and-capabilities.md).

**Scope:** Local dev. The data-model changes here (narrow `agent` table to chat-extension concerns, add `task.skill_id`) are destructive for any in-flight rows in postgres; the migration assumes we can drop and re-seed.

**Update:** Capabilities (per-task grants + per-agent ceilings) were dropped before this plan landed. Permission now lives on the skill via its `tools` list — a skill can call only the tools it declared. When network-layer enforcement or per-task scope narrowing is needed, reintroduce under a cleaner name.

**2026-04-24 update:** This plan is amended by [concepts.md](../architecture/concepts.md), which consolidates agents across runtimes. On the worker node (the runtime; renamed from "worker" to avoid the collision with the Executor Agent concept), the loop no longer calls `runSkill(id)` directly. It dispatches one of exactly two fixed agents based on request state: the **Planner Agent** (unplanned request) or the **Executor Agent** (planned, pending tasks). The Executor Agent calls `loadSkill(task.skill_id)` to pull in instructions + tool grants + done checks. Skills are resources agents load, not the agent itself. Phase structure below still applies; loop pseudocode, Planning section, and Phase C have been updated inline.

---

## What changes from today

| | Today | After |
|---|---|---|
| Worker claim unit | `Task` (filtered by `agent_id`) | `Request` |
| Worker per tick | Claim 0–N tasks across N handlers | Claim 1 Request; plan or execute 1 task |
| Planner | `/api/cron/process-tasks` | Whichever worker claims an unplanned Request runs the `planning` skill |
| Task target | `agent_id` → in-process `agentHandlers[id]` | `skill_id` → loaded `SKILL.md` |
| Permission scope | `agent.allowed_capabilities` ceiling | `skill.tools` list + `skill.owners` filter |
| Agent DB table | Present (UI grouping + config + ceiling) | Deleted |
| User-agent marketplace | Toggle agents on/off per user | Removed for now; may return as "skill bundles" |

---

## Skill DSL — adopt SKILL.md

Every skill lives as a directory under `apps/web/src/skills/<name>/` with a `SKILL.md` at the root. Frontmatter is YAML, body is the LLM-facing runbook. Supporting files (scripts, templates, fixtures) live beside the file and are referenced by relative path.

### Frontmatter schema (v0.1)

```yaml
name: string                # required, matches directory name
description: string         # required, used by planner to decide match
version: string             # required, for compatibility checks
owners: [string]            # required; agent ids that may loadSkill this. Filters list_skills(caller) too. e.g. ["ExecutorAgent", "DataArchitect"]
when:                       # optional matching hints for the planner
  triggers: [string]        # e.g. "pr.merged.logger_table"
  keywords: [string]        # freeform matching against request context
tools: [string]             # tool identifiers; resolved against the loading agent's runtime registry. Preflighted at loader startup against every owner's runtime.
auto_approve: boolean       # if true, request skips human approval
args:                       # input schema, JSON-Schema-ish
  <key>:
    type: string | number | boolean | object | array
    required: boolean
    default: unknown
    description: string
done:                       # programmatic verification steps
  - kind: sql | http | s3_object_exists | shell
    ...
```

### Body

Freeform Markdown. Becomes the system prompt when the worker invokes an LLM for this skill. Keep it task-oriented — no background prose.

### Migration from current formats

- `apps/web/src/skills/provision-logger-table.yaml` (recipe style) → becomes `apps/web/src/skills/provision-logger-table/SKILL.md` with frontmatter carrying `args`, `owners`, `tools`, `done`, and a body listing the tasks to emit at planning time.
- `apps/web/src/extensions/data-architect/skills/*.md` (prose runbook) → each gains a frontmatter block; metadata currently in `index.ts` registry moves into the file. The registry file shrinks to a loader.
- A new loader in `apps/web/src/lib/skills.ts` reads all SKILL.md files recursively, parses frontmatter (with `gray-matter` or similar), validates, returns typed records.

---

## Tool registry — runtime by registration

Tools are in-process TS functions. Each runtime owns its own registry, initialized at startup:

- **Chat runtime:** `apps/web/src/tools/chat/` — registers `renderCanvas`, `handoff`, `handback`, `loadSkill`, `finishSkill`, `getSkill`, etc.
- **Worker Node:** `apps/agent-worker/src/tools/` — registers `kafka:write`, `s3:write`, `trino:query`, `list_skills`, `emit_task`, `finish_planning`, `loadSkill`, `finishSkill`, etc.

Cross-runtime tools (`loadSkill`, `finishSkill`, `getSkill`) get registered in both. Nothing self-declares a `runtimes:` tag — a tool's runtime is "wherever it was registered."

```ts
// apps/web/src/tools/chat/index.ts (chat runtime)
registerTool({ id: "renderCanvas", handler: async (args, ctx) => { ... } });
registerTool({ id: "loadSkill",    handler: async (args, ctx) => { ... } });

// apps/agent-worker/src/tools/index.ts (worker node)
registerTool({ id: "kafka:write", handler: async (args, ctx) => { ... } });
registerTool({ id: "loadSkill",   handler: async (args, ctx) => { ... } });
```

When an agent's base tools or a loaded skill's `tools:` list names a tool that isn't in the current runtime's registry, it's dropped silently before the LLM sees it. To prevent silent breakage, the **skill loader runs a preflight check** at startup: for each skill × each owner, verify all declared `tools:` resolve in that owner's runtime registry. Mismatches warn (or fail validation, configurable).

This mirrors the skill design: nothing self-declares a runtime; runtime is "wherever you're owned/registered."

---

## Drop the agent table

Nothing in the new model needs `agent` as a DB entity. Permission lives on each skill (its `tools` list + `owners` filter). UI grouping can later re-emerge as "skill bundles" but is out of scope here.

### Schema changes

```sql
-- Replace agent_id with skill_id on tasks.
ALTER TABLE task ADD COLUMN skill_id text NOT NULL;
ALTER TABLE task DROP COLUMN agent_id;

-- user_agent is a join table keyed on agent; no longer needed.
DROP TABLE user_agent;

-- agent itself goes. permission now lives on skill.tools + skill.owners.
DROP TABLE agent;
```

Because local dev can drop+reseed, we don't need a data-preserving migration. For remote envs we'd need a back-fill script that maps `agent_id` → some default `skill_id`, but that's deferred.

### Code removals

- [apps/web/src/lib/actions/agents.ts](apps/web/src/lib/actions/agents.ts) — delete. `listAgents`, `enableAgent`, `disableAgent`, `getUserEnabledAgentIds` have no remaining callers once the skill loader lands.
- [apps/web/src/app/marketplace/page.tsx](apps/web/src/app/marketplace/page.tsx) and [apps/web/src/components/marketplace/](apps/web/src/components/marketplace/) — delete.
- In [apps/web/src/lib/task-queue.ts](apps/web/src/lib/task-queue.ts), `createTask(requestId, agentId, ...)` → `createTask(requestId, skillId, ...)`. Validation: named skill must exist.
- `applySkillRecipe`'s validation reduces to: skill exists and `owners.includes("ExecutorAgent")` (no cross-table join).
- [apps/web/src/db/seed.ts](apps/web/src/db/seed.ts) — drop agent seeding.

### Code additions

- `apps/web/src/lib/skills.ts` rewrite to load SKILL.md files, parse frontmatter, validate, cache.
- Skill registry exposed as `listSkills()`, `getSkill(name)`, `validateCapabilitiesForSkill(skillId, caps)`.

---

## One-request-per-worker loop

### The rules

1. A Worker Node holds at most **one Request** at a time.
2. When it claims a Request, it inspects state and dispatches one of two fixed agents:
   - **Unplanned** (status=`pending` and no tasks yet) → **Planner Agent**. Emits tasks, calls `finish_planning`, exits.
   - **Planned** (status=`approved` and pending tasks exist) → **Executor Agent**. Claims one task, calls `loadSkill(task.skill_id)`, runs the skill body, calls `finishSkill` to trigger `done[]`, exits.
3. After either path, the Worker Node releases the Request and loops again.
4. If all tasks are done, the Worker Node marks the Request `done`. If any failed, marks `failed`.

### Pseudocode

```ts
while (true) {
  const request = await claimRequest();
  if (!request) { await sleep(POLL_INTERVAL_MS); continue; }

  try {
    const tasks = await listTasks({ requestId: request.id });
    if (tasks.length === 0) {
      await runAgent(PlannerAgent, { request });
      // Planner emits tasks and calls finish_planning; Request flips to "approved"
    } else if (tasks.some(t => t.status === "pending")) {
      const task = await claimOneTaskForRequest(request.id, workerId);
      if (task) await runAgent(ExecutorAgent, { task, request });
      // Executor calls loadSkill(task.skill_id), runs the skill body, calls finishSkill
    } else if (tasks.every(t => t.status === "done")) {
      await completeRequest(request.id);
    } else if (tasks.some(t => t.status === "failed")) {
      await failRequest(request.id, "one or more tasks failed");
    }
  } finally {
    await releaseRequestClaim(request.id);
  }
}
```

### Claim endpoint changes

- Keep `POST /api/tasks/requests/claim` (already exists).
- Add `POST /api/tasks/requests/:id/claim-task` — atomically claim one pending task that belongs to this request, scoped to the authenticated worker. Needed because the existing `/api/tasks/claim` picks any pending task across all requests.
- Keep heartbeat on every claim poll.

### Concurrency implications

- "One active request per worker" means throughput scales by worker count. Revisit if we ever need intra-request parallelism (e.g. fan out 10 tasks and run them concurrently from one worker). For v0.1 sequential per-request is fine.
- The cron planner in `/api/cron/process-tasks` goes away entirely — workers are the planner now. The cron keeps its stale-claim reset pass from the previous plan.

---

## Planner Agent

One of two fixed agents on the Worker Node. **Has no `loadSkill` tool** — its planning instructions are baked into the agent definition for v0.1, and it cannot execute work. Walks the LLM through: read the Request, list available skills, emit one or more tasks, call `finish_planning`. Starts dumb — no clever heuristics, no multi-skill orchestration. Fine-tune once we have a second real skill to plan against.

Base tools (registered in the Worker Node's tool registry):
- `list_skills()` — returns skills owned by the Executor (`owners.includes("ExecutorAgent")`). The Planner's call hardcodes the Executor as the target; it doesn't list skills only itself could load.
- `emit_task({skill_id, description, done_criteria})` — inserts a task.
- `finish_planning({reason?})` — marks the request `approved` (or `failed` with reason).

These are NOT MCP tools — they're in-process function calls the Worker Node exposes to the LLM via the AI SDK's tool-calling interface.

If planning strategies later diverge by request type, give the Planner `loadSkill` and ship `planning-*` skills with `owners: [PlannerAgent]`. Not needed for v0.1.

## Executor Agent

The other fixed agent. Built per task: the runtime pre-loads `task.skill_id` (validating `owners.includes("ExecutorAgent")`) and constructs an agent whose **instructions are the skill body** and whose **tools are the skill's declared `tools:` plus `finishSkill`**. The LLM follows the runbook and calls `finishSkill` when complete.

Base tool (registered in the Worker Node's tool registry):
- `finishSkill({result})` — triggers the runtime's `done[]` checks. If all pass, marks the task `done`. If any fail, marks the task `failed` with the failing-check details.

The skill's declared `tools:` are added per-task at agent construction. Real work (Kafka writes, S3 uploads, Trino queries, PR submission) is delivered through those tools, not the Executor's base set.

**`loadSkill` as an LLM tool is deferred.** v0.1 has one task = one skill, so making the LLM call `loadSkill(task.skill_id)` adds a roundtrip with no real choice. Reintroduce it (and the matching `owners` check) when sub-skill loading mid-execution becomes a real need. Chat specialists, which legitimately load multiple skills per conversation, will use the same `owners:` filter when they get `loadSkill`.

---

## Implementation phases

### Phase A — Skill DSL + loader
1. Add `gray-matter` (or `@std/front-matter`) dep.
2. Rewrite `apps/web/src/lib/skills.ts` to load SKILL.md files, parse+validate frontmatter (including `owners: [agentId]`), export `listSkills(caller)` / `getSkill(id, caller)` that filter by `owners.includes(caller.id)`.
3. Migrate `provision-logger-table.yaml` → `provision-logger-table/SKILL.md` with `owners: [ExecutorAgent]`.
4. (Optional, can be later.) Migrate Data Architect runbooks with `owners: [DataArchitect]`.
5. Unit-test the loader (malformed frontmatter, unknown keys, missing required args, owners filter).
6. Add a startup preflight: for each skill × each owner, verify all declared `tools:` resolve in that owner's runtime tool registry. Warn (or fail, configurable) on mismatch.

### Phase B — Drop agent table
1. Drop FK from `task.agent_id` to nothing and replace with `skill_id`.
2. Drop `agent`, `user_agent` tables + schema types.
3. Delete `lib/actions/agents.ts`, marketplace page + components, seed entries.
4. Rewrite `createTask` / `applySkillRecipe` to use skill-level ceiling.
5. Regenerate schema, push.

### Phase C — Worker Node: Planner + Executor dispatch
1. Add `POST /api/tasks/requests/:id/claim-task` route + `claimTaskForRequest` helper.
2. Rewrite `apps/agent-worker/src/index.ts` main loop (the pseudocode above).
3. Define the two fixed agents in `apps/agent-worker/src/agents/`:
   - `PlannerAgent` — instructions + base tools (`list_skills`, `emit_task`, `finish_planning`). No `loadSkill`.
   - `ExecutorAgent` — instructions + base tools (`loadSkill`, `finishSkill`). `loadSkill` is task-scoped.
4. Implement `runAgent(agent, input)` which:
   - Instantiates a ToolLoopAgent (AI SDK) with the agent's instructions + base tools (filtered by runtime).
   - On `loadSkill`: reads SKILL.md, appends body to prompt (with arg substitution), additively grants the skill's `tools:` for the duration of the load.
   - On `finishSkill`: drops the grant, runs the skill's `done[]` checks, records the result on the task.
5. Register base tools in the Worker Node's tool registry (per-runtime registries — no `runtimes:` tag on tools).
6. Delete the `agentHandlers` registry and related plumbing.

### Phase D — Planner cron removal ✅ shipped (2026-04-24)
1. ✅ Plan pass removed from `/api/cron/process-tasks` (Phase A) — only the stale-claim reset remains.
2. ✅ Webhook handler simplified (Phase A) — always creates a `pending` request; the Worker Node's Planner Agent picks it up. The deterministic-recipe path was dropped since its referenced agents (schema-registry, dag) didn't exist in the seed and it was always falling through to the planner anyway.
3. ✅ Loop validated end-to-end by [verify-phase-c.ts](../../apps/web/src/db/verify-phase-c.ts): pending request → Planner emits tasks → Executor runs them → request rolls up to `done`.

The "webhook" source field doesn't change loop semantics, so a separate verify-phase-d wasn't authored — the Phase C verification covers both the human and webhook paths.

Each phase ships independently, but B is load-bearing for C and D.

---

## Open questions

1. **Supporting files beside SKILL.md** — when a skill references `scripts/fill.py`, does the worker pod have a checkout of the repo? Two options: bake skill directories into the worker image, OR mount via hostPath for local dev. Image-bake is simpler; fast iteration via the host-run worker stays the dev loop.
2. **Frontmatter validation library** — zod on top of `gray-matter`, or a dedicated schema lib? Probably zod.
3. **Skill bundles (UI)** — if we ever re-introduce the marketplace, is a "bundle" just a list of skill names the user toggles on/off? Leaving open — not in this plan's scope.
4. **Done-check DSL** — `done[]` in the Planning-skill draft is sketched but not specified. What `kind`s do we support on day 1? (sql, http, shell seem minimum; s3/iceberg later.) The executor for each kind runs inside the worker (not the LLM).
5. **What about human approval?** `auto_approve` in the skill frontmatter collapses today's auto-approve flag. Non-auto-approve skills land the Request at `awaiting_approval` after planning; who flips it to `approved`? Probably the existing request-detail UI. Not solved here.

## Deferred work (tracked separately)

- **Data Architect domain skills → SKILL.md migration.** The chat-side data-architect's `apps/web/src/extensions/data-architect/skills/*.md` files (entity, dimension, logger-table, lattik-table, metric) still ship as prose markdown baked into the agent's system prompt. Migration to the new SKILL.md frontmatter format (`owners: [DataArchitect]` + `tools` + `args` + `done`) was deferred from Phase B; revisit after Phase C lands chat-side `loadSkill`.

- **Deterministic webhook fan-out.** Phase A removed the YAML-recipe deterministic path; today every webhook event produces a plain `pending` request that the Planner Agent plans from scratch. When a webhook event becomes high-throughput enough that the planner LLM's latency / cost matters, reintroduce a TS dispatcher in [apps/web/src/app/api/webhooks/gitea/route.ts](../../apps/web/src/app/api/webhooks/gitea/route.ts) that emits N tasks pointing at runbook skills inline (skipping the planner). The skills already exist (`register-protobuf-schema`, `regenerate-airflow-dag`); just call `createTask` once per task in a transaction and land the request at `approved`.

- **Per-skill `stale_timeout_ms` in SKILL.md frontmatter.** Phase B collapsed the per-agent stale timeout to a single `DEFAULT_STALE_TIMEOUT_MS = 5 min` constant. Add `stale_timeout_ms?: number` to the schema and read it in [task-queue.ts](../../apps/web/src/lib/task-queue.ts) `claimTask`/`claimTaskForRequest` once a real skill needs longer (Spark backfills, S3 syncs).

- **Legacy `TASK_AGENT_SECRET` / `requireTaskAuth`.** Several human/UI-facing endpoints (`/api/tasks/requests/*`, `/api/tasks/requests/[id]/messages|submit|approve|complete`) still use the legacy single-key shared secret. Phase C migrated only the worker-called endpoints to per-worker `requireWorkerAuth`. Audit the remaining `requireTaskAuth` callers and either move them to `requireWorkerAuth` (if the worker is a legitimate caller) or to `requireUser` (if they're chat/UI-only).

- **`loadSkill` as an LLM tool.** Phase C.3 deferred this — every task has exactly one skill, so the runtime pre-loads from `task.skill_id` and skips the LLM roundtrip. Reintroduce when sub-skill loading mid-execution becomes a real need; the docs describe how this would slot in.

- **Node TLS + portless `https://lattik-studio.dev` from agent-worker.** Node's fetch under tsx couldn't validate the portless self-signed cert even with `--use-system-ca`. Phase D worked around it by defaulting [agent-worker/.env](../../apps/agent-worker/.env) to `http://localhost:3737`. Real fix: import the portless root CA into the Node trust store, or have portless emit a public-CA-signed cert for `.dev` domains.

---

## Relationship to the previous plan

Everything shipped in [PLAN-worker-deployment-and-capabilities.md](PLAN-worker-deployment-and-capabilities.md) stays:

- Heartbeat + stale-claim release
- Studio-managed worker lifecycle (cluster + host modes)
- Deterministic webhook → skill fan-out path
- Worker image + kind manifest

What changes is *what fills the handler slot*. Instead of `agentHandlers["kafka"]` in TS, the worker loads a SKILL.md, instantiates a ToolLoopAgent from its declared tools/prompt, and runs. Deployment topology, auth, liveness are unchanged.
