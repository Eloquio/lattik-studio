# Core concepts

Lattik Studio has one shared abstraction for LLM-driven work: an **Agent**. Agents run in two **runtimes** (chat and worker node), use **tools** to take action, and load **skills** as on-demand runbooks. Agents are runtime-bound by definition; skills and tools are runtime-neutral and bind to a runtime by being owned/registered there.

---

## Agent

An agent is an instance of a `ToolLoopAgent`: a system prompt + a base tool list + access to the skill registry. Each agent is bound to **exactly one runtime** by definition (e.g. Data Architect lives in chat; the Executor Agent lives on the Worker Node). The runtime supplies tool implementations and owns the lifecycle — long-lived streaming response in chat, one-shot tool loop on the worker.

There are a small number of named agents.

### Chat-runtime agents

Live in-process inside the Next.js app, stream to the chat panel + canvas, persist conversation state on the `conversations` row.

- **Assistant** (concierge) — base tools: `handoff`. Triages every new conversation, routes to a specialist, knows about the paused-task stack.
- **Specialist** (Data Architect, Data Analyst, Pipeline Manager, …) — base tools: `handback`, `loadSkill`, `renderCanvas`. Handles a domain; loads skills from its domain library on demand (e.g. Data Architect loads `entity`, `metric`, `logger-table` as the user names them — gated by the skill's `owners:` list).

Routing between Assistant and Specialists uses `handoff`/`handback` with a depth-1 task stack — see [agent-handoff.md](agent-handoff.md).

### Worker-node agents

Exactly two, dispatched by request state. Each runs to completion per claim, then the Worker Node loops.

- **Planner Agent** — base tools: `list_skills`, `emit_task`, `finish_planning`. **No `loadSkill`** — the Planner cannot execute work, only schedule it. `list_skills()` returns skills owned by the Executor (the only agent that can act on them).
- **Executor Agent** — base tools: `finishSkill`. Claims one pending task; the runtime pre-loads `task.skill_id` (validating `owners.includes("ExecutorAgent")`) before invoking the LLM, so the agent's instructions are the skill body and its tools are the skill's declared `tools:` plus `finishSkill`. Runs the runbook, calls `finishSkill` to trigger `done[]`, releases. (`loadSkill` returns as an LLM-callable tool when sub-skill loading mid-execution becomes a real need; v0.1 has one task = one skill.)

Dispatch logic on every claim:

| Request state | Tasks | Agent dispatched |
|---|---|---|
| `pending` | 0 | Planner |
| `approved` | ≥1 pending | Executor |
| `approved` | all done | (no agent — mark request `done`) |
| `approved` | any failed | (no agent — mark request `failed`) |

Webhook-deterministic requests skip the Planner: the recipe simulates what it would have emitted, the request lands at `approved` with tasks pre-fanned out, and the next Executor claim picks one up.

---

## Skill

A resource an agent loads on demand. Lives at `apps/web/src/skills/<name>/SKILL.md`: YAML frontmatter (name, description, version, **`owners`**, `tools`, `args`, `done`, `auto_approve`, `when.triggers/keywords`) plus a Markdown body that becomes the loading agent's instructions for the duration of the load.

`owners: [agentId]` is the permission gate. Only agents in this list can `loadSkill` it; `list_skills(caller)` filters to skills the caller owns. A skill loadable by both the Executor Agent and the Data Architect Specialist sets `owners: [ExecutorAgent, DataArchitect]`.

When an agent calls `loadSkill(id)`, the runtime:
1. Validates `owners.includes(caller.id)` — rejects otherwise.
2. Appends the skill body to the agent's prompt (with arg substitution).
3. **Additively grants** the skill's declared `tools:` for the duration of the load — but only those registered in the caller's runtime; missing ones are dropped silently.
4. Watches for `finishSkill({result})`, then runs the skill's `done[]` programmatic checks.

Skills aren't agents — they're payloads. They're runtime-neutral; the runtime they execute in is whichever agent loaded them.

See: [PLAN-skill-based-worker-loop.md](../archive/PLAN-skill-based-worker-loop.md) for the SKILL.md schema and loader.

---

## Tool

A function the LLM can call via the AI SDK's tool-calling interface. Tools come from two sources:

1. **Agent base** — declared on the agent definition (e.g. `handoff` on Assistant, `loadSkill` on Executor).
2. **Loaded skill** — added when the agent calls `loadSkill`, dropped on `finishSkill`.

A tool's runtime is implicit from where it's registered. Each runtime owns its registry:
- **Chat:** `apps/web/src/tools/chat/` — registers `renderCanvas`, `handoff`, `handback`, `loadSkill`, `finishSkill`, `getSkill`.
- **Worker Node:** `apps/agent-worker/src/tools/` — registers `kafka:write`, `s3:write`, `trino:query`, `list_skills`, `emit_task`, `finish_planning`, `loadSkill`, `finishSkill`.

Cross-runtime tools (`loadSkill`, `finishSkill`, `getSkill`) get registered in both. Nothing self-declares a `runtimes:` tag.

If an agent's base tools or a loaded skill's `tools:` list names a tool that isn't in the current runtime's registry, it's dropped silently. To catch this at design time, the **skill loader runs a preflight check** at startup: for each skill × each owner, verify all declared `tools:` resolve in that owner's runtime registry. Mismatches warn.

---

## Worker Node

The runtime that hosts the Planner and Executor agents. A long-running process — either a kind Deployment in the `workers` namespace or a host-mode `pnpm --filter agent-worker dev` — that polls the request queue, claims one Request at a time, dispatches Planner or Executor based on state, runs it to completion, releases the claim, loops.

A Worker Node is identified by `worker.id` (UUID) + a bearer secret. Liveness is heartbeat-based: every claim poll bumps `worker.last_seen_at`; the UI flags ≤30s as online.

Worker Nodes have no business logic of their own — they're a runtime. All behavior lives in the two agents and the skills they load.

See: [PLAN-worker-deployment-and-capabilities.md](../archive/PLAN-worker-deployment-and-capabilities.md) for deployment and identity.

---

## How they fit together

```
Chat runtime:
  User --> Assistant --handoff--> Data Architect (Specialist)
                                       |
                                       +-- loadSkill("entity") ---------> entity SKILL.md
                                       |     (owners must include DataArchitect;
                                       |      grants: validateEntity, renderCanvas, ...)
                                       +-- finishSkill({result})
                                             (runtime runs done[] checks if any)

Worker node:
  Request (queued) --> Worker Node claims it
                          |
                          +-- if unplanned --> Planner Agent
                          |                       |
                          |                       +-- list_skills (filtered to Executor-owned)
                          |                       +-- emit_task(s)
                          |                       +-- finish_planning
                          |
                          +-- if planned   --> Executor Agent
                                                  |
                                                  | (runtime pre-loads task.skill_id as
                                                  |  the agent's instructions + tool grants;
                                                  |  owners must include ExecutorAgent)
                                                  |
                                                  +-- finishSkill({result})
                                                        (runtime runs done[] checks)
```

One concept (Agent), one resource type (Skill), one capability primitive (Tool). Agents are runtime-bound; skills and tools are runtime-neutral and bind to a runtime by ownership/registration.
