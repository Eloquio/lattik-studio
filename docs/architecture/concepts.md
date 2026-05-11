# Core concepts

Lattik Studio has one shared abstraction for LLM-driven work: an **Agent**. Agents run in two **runtimes** (chat and skill-run workflow), use **tools** to take action, and load **skills** as on-demand runbooks. Agents are runtime-bound by definition; skills and tools are runtime-neutral and bind to a runtime by being owned/registered there.

---

## Agent

An agent is an instance of a `ToolLoopAgent`: a system prompt + a base tool list + access to the skill registry. Each agent is bound to **exactly one runtime** by definition (e.g. Data Architect lives in chat; the Executor Agent runs as a Vercel Workflow). The runtime supplies tool implementations and owns the lifecycle — long-lived streaming response in chat, one-shot durable run in the workflow.

There are a small number of named agents.

### Chat-runtime agents

Live in-process inside `apps/agent-service` (proxied from the Next.js app), stream to the chat panel + canvas, persist conversation state on the `conversations` row.

- **Assistant** (concierge) — base tools: `handoff`. Triages every new conversation, routes to a specialist, knows about the paused-task stack.
- **Specialist** (Data Architect, Data Analyst, Pipeline Manager, …) — base tools: `handback`, `loadSkill`, `renderCanvas`. Handles a domain; loads skills from its domain library on demand (e.g. Data Architect loads `entity`, `metric`, `logger-table` as the user names them — gated by the skill's `owners:` list).

Routing between Assistant and Specialists uses `handoff`/`handback` with a depth-1 task stack — see [agent-handoff.md](agent-handoff.md).

### Skill-run-runtime agents

One agent only:

- **Executor Agent** — runs inside a Vercel Workflow (`apps/agent-service/src/workflows/skill-run.ts`). Each run is HTTP-triggered with a `skillId` + args, loads `SKILL.md` (validating `owners.includes("ExecutorAgent")`), executes the runbook with the skill's declared `tools:` plus `finishSkill`, and returns the result. No claim-and-poll, no queue — one workflow run per trigger.

Today's trigger paths:

| Trigger | Skill |
|---|---|
| Gitea PR-merge webhook (`apps/web/src/app/api/webhooks/gitea/route.ts`) | `post-pipeline-pr-merge` |

There is no Planner — every production trigger today decomposes to exactly one skill. If multi-skill orchestration shows up later, reintroduce it as a parent workflow that starts child skill-run workflows.

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
- **Chat:** chat-side tools live in `apps/agent-service/src/agents/<Specialist>/tools/` and `apps/web/src/extensions/<extension>/tools/`. The harness's `CHAT_TOOLS` set in [`packages/agent-harness/src/tools.ts`](../../packages/agent-harness/src/tools.ts) is the canonical list (`renderCanvas`, `handoff`, `handback`, `loadSkill`, `finishSkill`, `getSkill`).
- **Skill-run workflow:** `apps/agent-service/src/agents/Executor/tools/` — registers `create_kafka_topic`, `emit_logger_proto`, `register_protobuf_schema`, `create_iceberg_table`, `start_logger_writer`, `loadSkill`, `finishSkill`. Mirrored in the harness's `EXECUTOR_TOOLS` set.

Cross-runtime tools (`loadSkill`, `finishSkill`, `getSkill`) get registered in both. Nothing self-declares a `runtimes:` tag.

If an agent's base tools or a loaded skill's `tools:` list names a tool that isn't in the current runtime's registry, it's dropped silently. To catch this at design time, the **skill loader runs a preflight check** at startup: for each skill × each owner, verify all declared `tools:` resolve in that owner's runtime registry. Mismatches warn.

---

## Skill-run workflow

The runtime that hosts the Executor Agent. Each trigger (today: the Gitea PR-merge webhook) starts a Vercel Workflow run via `start(runSkillWorkflow, [{ runId, skillId, args }])` — the workflow loads the skill, runs the agent loop, and returns durably. WDK handles retries, crash recovery, and step persistence.

Implementation: [`apps/agent-service/src/workflows/skill-run.ts`](../../apps/agent-service/src/workflows/skill-run.ts) (workflow body) + [`apps/agent-service/src/routes/__wf-skill-run.post.ts`](../../apps/agent-service/src/routes/__wf-skill-run.post.ts) (HTTP trigger).

The current implementation wraps the whole agent loop in a single `'use step'` because every post-merge tool is idempotent (kafka topic create-if-not-exists, iceberg `CREATE TABLE IF NOT EXISTS`, `kubectl apply`, etc.) — replay-from-scratch on retry is safe. If non-idempotent tools land later, switch to per-tool steps the way `agent-loop.ts:runToolStep` does for chat.

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

Skill-run workflow:
  Gitea PR-merge --> webhook handler --> POST /__wf-skill-run
                                              |
                                              v
                                         Vercel Workflow run
                                              |
                                              +-- Executor Agent
                                                    |
                                                    | (workflow loads task.skill_id as
                                                    |  the agent's instructions + tool grants;
                                                    |  owners must include ExecutorAgent)
                                                    |
                                                    +-- finishSkill({result})
                                                          (runtime runs done[] checks)
```

One concept (Agent), one resource type (Skill), one capability primitive (Tool). Agents are runtime-bound; skills and tools are runtime-neutral and bind to a runtime by ownership/registration.
