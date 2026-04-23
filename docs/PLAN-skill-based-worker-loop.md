# Plan: Skill-based Worker Loop

**Goal:** Consolidate the agent + handler model into a single concept — **skills**. Workers poll Requests (not Tasks), decide per-iteration whether to plan or execute, and dispatch by skill rather than by agent. This is the follow-up to [PLAN-worker-deployment-and-capabilities.md](PLAN-worker-deployment-and-capabilities.md).

**Scope:** Local dev. The data-model changes here (narrow `agent` table to chat-extension concerns, add `task.skill_id`) are destructive for any in-flight rows in postgres; the migration assumes we can drop and re-seed.

**Update:** Capabilities (per-task grants + per-agent ceilings) were dropped before this plan landed. Permission now lives on the skill via its `tools` list — a skill can call only the tools it declared. When network-layer enforcement or per-task scope narrowing is needed, reintroduce under a cleaner name.

---

## What changes from today

| | Today | After |
|---|---|---|
| Worker claim unit | `Task` (filtered by `agent_id`) | `Request` |
| Worker per tick | Claim 0–N tasks across N handlers | Claim 1 Request; plan or execute 1 task |
| Planner | `/api/cron/process-tasks` | Whichever worker claims an unplanned Request runs the `planning` skill |
| Task target | `agent_id` → in-process `agentHandlers[id]` | `skill_id` → loaded `SKILL.md` |
| Capability ceiling | `agent.allowed_capabilities` | `skill.capabilities` in frontmatter |
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
when:                       # optional matching hints for the planner
  triggers: [string]        # e.g. "pr.merged.logger_table"
  keywords: [string]        # freeform matching against request context
tools: [string]             # tool identifiers the skill's LLM may invoke
capabilities: [string]      # upper bound; a Task may carry a subset
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

- `apps/web/src/skills/provision-logger-table.yaml` (recipe style) → becomes `apps/web/src/skills/provision-logger-table/SKILL.md` with frontmatter carrying `args`, `capabilities`, `done`, and a body listing the tasks to emit at planning time.
- `apps/web/src/extensions/data-architect/skills/*.md` (prose runbook) → each gains a frontmatter block; metadata currently in `index.ts` registry moves into the file. The registry file shrinks to a loader.
- A new loader in `apps/web/src/lib/skills.ts` reads all SKILL.md files recursively, parses frontmatter (with `gray-matter` or similar), validates, returns typed records.

---

## Drop the agent table

Nothing in the new model needs `agent` as a DB entity. Ceiling moves to `skill.capabilities`. UI grouping can later re-emerge as "skill bundles" but is out of scope here.

### Schema changes

```sql
-- Replace agent_id with skill_id on tasks.
ALTER TABLE task ADD COLUMN skill_id text NOT NULL;
ALTER TABLE task DROP COLUMN agent_id;

-- user_agent is a join table keyed on agent; no longer needed.
DROP TABLE user_agent;

-- agent itself goes. allowed_capabilities is already absorbed by skill.
DROP TABLE agent;
```

Because local dev can drop+reseed, we don't need a data-preserving migration. For remote envs we'd need a back-fill script that maps `agent_id` → some default `skill_id`, but that's deferred.

### Code removals

- [apps/web/src/lib/actions/agents.ts](apps/web/src/lib/actions/agents.ts) — delete. `listAgents`, `enableAgent`, `disableAgent`, `getUserEnabledAgentIds` have no remaining callers once the skill loader lands.
- [apps/web/src/app/marketplace/page.tsx](apps/web/src/app/marketplace/page.tsx) and [apps/web/src/components/marketplace/](apps/web/src/components/marketplace/) — delete.
- In [apps/web/src/lib/task-queue.ts](apps/web/src/lib/task-queue.ts), `createTask(requestId, agentId, ...)` → `createTask(requestId, skillId, ...)`. Capability subset check now lookup skill, not agent.
- `applySkillRecipe`'s validation path switches to `skill.capabilities` lookup (same skill that's being applied — no cross-table join).
- [apps/web/src/db/seed.ts](apps/web/src/db/seed.ts) — drop agent seeding.

### Code additions

- `apps/web/src/lib/skills.ts` rewrite to load SKILL.md files, parse frontmatter, validate, cache.
- Skill registry exposed as `listSkills()`, `getSkill(name)`, `validateCapabilitiesForSkill(skillId, caps)`.

---

## One-request-per-worker loop

### The rules

1. A worker holds at most **one Request** at a time.
2. When it claims a Request, it inspects state and takes one of two paths:
   - **Unplanned** (status=`pending` and no tasks yet) → runs the `planning` skill, emits tasks, calls `finish_planning`, releases the request.
   - **Planned** (status=`approved` and pending tasks exist) → claims one of its tasks, runs the task's skill, completes it.
3. After either path, the worker releases the Request and loops again.
4. If a Request has no pending tasks AND no work to plan (e.g. all tasks done), the worker marks it `done` and releases.

### Pseudocode

```ts
while (true) {
  const request = await claimRequest();
  if (!request) { await sleep(POLL_INTERVAL_MS); continue; }

  try {
    const tasks = await listTasks({ requestId: request.id });
    if (tasks.length === 0) {
      await runSkill("planning", { request });
      // planning skill calls emit_task + finish_planning; Request flips to "approved"
    } else if (tasks.some(t => t.status === "pending")) {
      const task = await claimOneTaskForRequest(request.id, workerId);
      if (task) await runSkill(task.skill_id, { task, request });
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

## Planning skill — initial draft

Lives at [apps/web/src/skills/planning/SKILL.md](../apps/web/src/skills/planning/SKILL.md). Walks the LLM through: read the Request, list available skills, emit one or more tasks, call `finish_planning`. Starts dumb — no clever heuristics, no multi-skill orchestration. Fine-tune once we have a second real execution skill to plan against.

Tools the planning skill needs:
- `list_skills()` — returns the registry so the LLM can pick one.
- `emit_task({skill_id, description, done_criteria, capabilities})` — validates subset, inserts.
- `finish_planning({reason?})` — marks the request `approved` (or `failed` with reason).

These are NOT MCP tools — they're in-process function calls the worker exposes to the LLM via the AI SDK's tool-calling interface.

---

## Implementation phases

### Phase A — Skill DSL + loader
1. Add `gray-matter` (or `@std/front-matter`) dep.
2. Rewrite `apps/web/src/lib/skills.ts` to load SKILL.md files, parse+validate frontmatter, export `listSkills()` / `getSkill()`.
3. Migrate `provision-logger-table.yaml` → `provision-logger-table/SKILL.md`.
4. (Optional, can be later.) Migrate Data Architect runbooks.
5. Unit-test the loader (especially: malformed frontmatter, unknown keys, missing required args).

### Phase B — Drop agent table
1. Drop FK from `task.agent_id` to nothing and replace with `skill_id`.
2. Drop `agent`, `user_agent` tables + schema types.
3. Delete `lib/actions/agents.ts`, marketplace page + components, seed entries.
4. Rewrite `createTask` / `applySkillRecipe` to use skill-level ceiling.
5. Regenerate schema, push.

### Phase C — One-request-per-worker loop
1. Add `POST /api/tasks/requests/:id/claim-task` route + `claimTaskForRequest` helper.
2. Rewrite `apps/agent-worker/src/index.ts` main loop (the pseudocode above).
3. Add `runSkill(skillId, input)` in the worker that:
   - Loads the skill's frontmatter + body.
   - Instantiates a ToolLoopAgent (AI SDK) with the declared tools + system prompt.
   - Runs, then executes the `done[]` checks.
4. Implement the three planning-skill tools (`list_skills`, `emit_task`, `finish_planning`).
5. Delete the `agentHandlers` registry and related plumbing.

### Phase D — Planner cron removal
1. Remove the plan pass from `/api/cron/process-tasks`; keep the stale-claim reset.
2. Verify webhooks still work: deterministic path (skillId pre-set) continues as-is; fallback path (no skill match) now lands at status=`pending` with no tasks, to be picked up by a worker's planning skill.

Each phase ships independently, but B is load-bearing for C and D.

---

## Open questions

1. **Supporting files beside SKILL.md** — when a skill references `scripts/fill.py`, does the worker pod have a checkout of the repo? Two options: bake skill directories into the worker image, OR mount via hostPath for local dev. Image-bake is simpler; fast iteration via the host-run worker stays the dev loop.
2. **Frontmatter validation library** — zod on top of `gray-matter`, or a dedicated schema lib? Probably zod.
3. **Skill bundles (UI)** — if we ever re-introduce the marketplace, is a "bundle" just a list of skill names the user toggles on/off? Leaving open — not in this plan's scope.
4. **Done-check DSL** — `done[]` in the Planning-skill draft is sketched but not specified. What `kind`s do we support on day 1? (sql, http, shell seem minimum; s3/iceberg later.) The executor for each kind runs inside the worker (not the LLM).
5. **What about human approval?** `auto_approve` in the skill frontmatter collapses today's auto-approve flag. Non-auto-approve skills land the Request at `awaiting_approval` after planning; who flips it to `approved`? Probably the existing request-detail UI. Not solved here.
6. **Planning skill's own capability grant.** The planner emits tasks with capabilities but doesn't touch anything external itself — `task:emit` is the only capability it needs. Sanity-check this is enforceable via the existing capability plumbing (task:emit isn't an external resource; probably just a no-op in the runtime guard).

---

## Relationship to the previous plan

Everything shipped in [PLAN-worker-deployment-and-capabilities.md](PLAN-worker-deployment-and-capabilities.md) stays:

- Heartbeat + stale-claim release
- Studio-managed worker lifecycle (cluster + host modes)
- Per-task capability column + subset enforcement
- Deterministic webhook → skill fan-out path
- Worker image + kind manifest

What changes is *what fills the handler slot*. Instead of `agentHandlers["kafka"]` in TS, the worker loads a SKILL.md, instantiates a ToolLoopAgent from its declared tools/prompt, and runs. Deployment topology, auth, liveness are unchanged.
