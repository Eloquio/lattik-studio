# PLAN: Multi-client agent service

> **Status:** Forward-looking architecture plan. Not yet implemented. Move to `docs/archive/` when shipped.

## Goal

Extract the chat-runtime agents (Assistant + Specialists) out of `apps/web` into a standalone backend service so multiple chat clients — the web app, a Slack bot, a Discord bot, a CLI, etc. — can share the same agent backend. The web app becomes one consumer of the service, not the home of the agents.

The worker-node agents (Planner, Executor) already live in their own service (`apps/agent-worker`); this plan does not change them.

## The actual hard part

Moving the agent definitions, tools, and skill loader into a sibling Nitro service is a refactor — mostly mechanical. The architectural decision that *makes or breaks* multi-client is decoupling **agent reasoning** from **canvas rendering**.

Today, the Pipeline Manager calls `renderDagOverview(...)` and the tool returns a `@json-render/react` spec. The web client streams that spec to its canvas. Slack can't render a json-render spec — it needs Block Kit. Discord wants embeds. A CLI wants formatted text.

The fix: the service's render-shaped tools must emit **render-intents** (semantic "show the user the DAG overview with these data points"), and each client owns the adapter that turns the render-intent into its native UI.

Without this split, the service is still web-only; you've just moved code across a network boundary.

## Target architecture

```
apps/
  web/                  Next.js — UI + json-render adapter; calls agent-service over HTTPS
  agent-service/        Nitro — Assistant + Specialists, /chat SSE endpoint, render-intent emitter
    src/
      agents/                      one folder per agent — owns its AGENT.md, skills, and tools
        assistant/AGENT.md
        data-architect/
          AGENT.md
          skills/                  flat — one .md per skill (matches current convention)
            defining-entity.md
            defining-dimension.md
            defining-logger-table.md
            defining-lattik-table.md
            defining-metric.md
            reviewing-definitions.md
          tools/                   agent-owned domain tools
            update-definition.ts, review-definition.ts, static-check.ts,
            submit-pr.ts, …
        data-analyst/
          AGENT.md
          skills/exploring-data.md
          tools/
            list-tables.ts, describe-table.ts, run-query.ts,
            render-chart.ts, render-sql-editor.ts, update-layout.ts
        pipeline-manager/
          AGENT.md
          skills/
            monitoring-dags.md
            triggering-runs.md
            troubleshooting-failures.md
            monitoring-logger-tables.md          (planned)
          tools/
            list-dags.ts, get-dag-detail.ts, list-dag-runs.ts,
            get-task-instances.ts, get-task-logs.ts,
            render-dag-overview.ts, render-dag-run-detail.ts,
            get-logger-table-status.ts            (planned)
      tools/                       chat-runtime-shared tools (small — used by multiple agents)
        read-canvas-state.ts
      lib/                         shared infra clients (airflow, gitea, trino, kafka, schema-registry)
      http/                        Nitro routes — POST /chat (SSE), auth bridge
  agent-worker/         (unchanged, gains agent-harness dep) Planner + Executor, polls request queue
  slack-bot/            (Phase 2) Slack adapter, calls agent-service
  discord-bot/          (later)   Discord adapter, calls agent-service

packages/
  agent-harness/        Runtime-neutral substrate — AGENT.md / SKILL.md loaders, ToolLoopAgent
                        wrapper, Tool / Agent / Skill base types, lifecycle tools
                        (loadSkill, finishSkill, handoff, handback, getSkill).
                        No agent-specific or runtime-specific code.
  chat-protocol/        Wire types: ChatRequest, ChatChunk (text | render-intent | tool-call | …)
  render-intents/       Render-intent schemas (DagOverview, DagRunDetail, LoggerTableStatus, …)
  json-render-adapter/  Web adapter — render-intent → json-render spec
  block-kit-adapter/    (Phase 2) Slack adapter — render-intent → Block Kit blocks
```

The clean test for "does this go in `agent-harness`?": *would the worker-node agents (Planner, Executor) also use it?* The AGENT.md / SKILL.md loaders, the ToolLoopAgent wrapper, the skill-lifecycle tools, and the Tool / ToolContext type all pass that test. A specific agent's tools (`renderDagOverview`, `submitPR`) and an agent's instructions (the AGENT.md body) do not — those are owned by whichever runtime the agent lives in.

```
                   ┌──────────────────┐
                   │ apps/agent-service│  Nitro on Vercel Fluid Compute
                   │  POST /chat (SSE) │  - resolves user identity from bearer token
                   │  resumable runs   │  - streams ChatChunk events
                   └─────────┬─────────┘
                             │ ChatChunks (text + render-intents)
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  apps/web             apps/slack-bot        apps/discord-bot
  json-render          Block Kit             Embeds
  canvas                blocks
```

## Agent definition format (AGENT.md)

Each agent is a single Markdown file with YAML frontmatter — the same convention as SKILL.md. The harness reads these at startup and instantiates a `ToolLoopAgent` per file. There are **no per-agent `.ts` files** in `apps/agent-service/src/agents/`.

```markdown
---
id: pipeline-manager
name: Pipeline Manager
description: Monitor and operate the data ecosystem — Logger Tables and Airflow DAGs
model: anthropic/claude-sonnet-4.6
max_steps: 10
base_tools:
  - getSkill
  - readCanvasState
  - listDags
  - getDagDetail
  - listDagRuns
  - getTaskInstances
  - getTaskLogs
  - renderDagOverview
  - renderDagRunDetail
  - handback
---

You are the Pipeline Manager agent in Lattik Studio. You are the
data-ecosystem reliability specialist…

## Available Skills
{{skills}}

## How to Work
1. Understand what the user wants to do …
…
```

### Frontmatter schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable agent id; matches the folder name. |
| `name` | string | yes | Human-readable display name. |
| `description` | string | yes | One-liner shown in the chat UI's specialist picker. |
| `model` | string | yes | AI Gateway model id (e.g. `anthropic/claude-sonnet-4.6`). |
| `max_steps` | number | yes | Tool-loop step cap (today: 10 for specialists). |
| `base_tools` | string[] | yes | Tool names resolved against the agent's merged tool registry (harness ⊕ runtime-shared ⊕ this agent's `tools/`). |

### Template seams

The body is mostly literal — it becomes the agent's system prompt verbatim. Only two substitution tokens are recognized, and they are **deliberately capped**:

- `{{skills}}` — replaced with the bullet list of skills owned by this agent (computed from the `skills/*.md` directory).
- `{{resumeContext}}` — replaced with `[CONTEXT] …\n\n` when the harness is resuming a previous run, otherwise empty.

If a real new need shows up, add a third token explicitly. **Do not** introduce general-purpose templating (no `{{user.email}}`, `{{currentDate}}`, `{{recentEvents}}`) — that's the slope from "declarative prose" back into "implicit code via templates."

### What `agent-harness` does at startup

1. **Glob** `apps/agent-service/src/agents/*/AGENT.md` (and the analogous worker-side path), parse YAML frontmatter + Markdown body.
2. **Build** a per-agent merged tool registry: harness tools ⊕ runtime-shared tools ⊕ that agent's `tools/`. Forbid name collisions. **Resolve** each name in `base_tools` against this merged registry. **Fail loudly** if any name is unknown or collides — this preflight is the only protection against typos and accidental shadowing now that we've left TS-level checking behind.
3. **Glob** `agents/<id>/skills/*.md`, parse SKILL.md frontmatter, validate `owners.includes(<id>)`, register in the skill registry.
4. **Build** a `ToolLoopAgent` per AGENT.md: instructions = body (with `{{skills}}` and `{{resumeContext}}` substituted), tools = resolved `base_tools` plus harness-injected lifecycle tools (`loadSkill`, `finishSkill`), model + step cap from frontmatter.
5. **Expose** the registered agents to the HTTP layer via `getAgent(id)` / `listAgents()`.

### Tool registry and `ToolContext`

Tools stay as `.ts` files — they're real code (Airflow HTTP calls, zod schemas, DB writes). They live in three tiers, each with clear ownership:

1. **`packages/agent-harness/src/tools/`** — runtime-neutral lifecycle tools (`loadSkill`, `finishSkill`, `getSkill`, `handoff`, `handback`). Both the chat runtime and the worker runtime depend on these.
2. **`apps/agent-service/src/tools/`** — chat-runtime-shared tools that any chat agent might legitimately want. Today this is essentially `readCanvasState`. Keep it small; if a tool ends up only being used by one agent, push it down to that agent's folder.
3. **`apps/<service>/src/agents/<id>/tools/`** — agent-owned domain tools (`listDags`, `runQuery`, `submitPR`, `renderDagOverview`, …).

At startup, the harness builds a per-agent merged registry — harness tools ⊕ runtime-shared tools ⊕ that agent's tools. **Name collisions are forbidden, not silently shadowed**: if an agent's `tools/` declares a name that already exists in the harness or runtime-shared tier, startup fails with the conflict surfaced explicitly. Collisions are almost always bugs.

Each tool's `execute(input, ctx)` receives a `ToolContext` carrying request-scoped values:

```ts
type ToolContext = {
  user: { id: string; email: string; clientId: 'web' | 'slack' | 'discord' | … };
  conversationId: string;
  canvasState: unknown;            // null for clients that don't have a canvas
  db: DrizzleClient;
  gateway: AIGateway;
  emitRenderIntent: (intent: RenderIntent) => void;
};
```

This is what replaces the closures in today's `agent.ts` files (`getCanvasState`, `resumeContext`, etc.). Closures-in-constructor become context-in-invocation: easier to test, no per-agent factory boilerplate.

## Contract: render-intents

A render-intent is a typed semantic instruction: *what* to show, not *how*. Each surface the agent can render becomes one render-intent type. Adapters are pure functions from render-intent → native UI.

```ts
// packages/render-intents

export type RenderIntent =
  | { kind: 'dag-overview';      data: { dags: DagSummary[] } }
  | { kind: 'dag-run-detail';    data: { dagId: string; runId: string; tasks: TaskInstance[] } }
  | { kind: 'logger-table-status'; data: { table: string; kafka: KafkaState; iceberg: IcebergState } }
  | { kind: 'sql-editor';        data: { sql: string; result?: QueryResult } }
  | { kind: 'definition-review'; data: { kind: DefKind; before: unknown; after: unknown } }
  // …
```

The agent's tool surface returns render-intents instead of json-render specs. Adapters live with each client. The web client's adapter wraps the existing canvas registry; new clients implement only the kinds they care about (a Slack bot might no-op `definition-review` and ask the user to use the web UI for that one).

This is a meaningful API surface — design it deliberately. Two rules of thumb:

1. **Render-intents carry data, not layout.** A `dag-overview` intent has the list of DAGs and their statuses, not "two columns, status badge on the right."
2. **Render-intents are append-only at the schema level.** Adding a field is fine; renaming or restructuring breaks every client. Version where you must.

## Auth fan-out

Each client owns its own user identification (NextAuth session for web, Slack OAuth + signing-secret for Slack, Discord OAuth for Discord, etc.). The agent-service trusts each client through a separate **trusted-client bridge**:

```
Web    --[NextAuth session]--> /api/agent-proxy --[client cred + user]--> agent-service
Slack  --[Slack signature   ]--> slack-bot      --[client cred + user]--> agent-service
```

The service never validates Slack signatures itself — that's the bot's job. The service validates that the bridge is one of a known list of trusted clients (mTLS or shared secret), and trusts the user identity it asserts. Conversation rows get scoped by `(client_id, user_id)` so a Slack user's threads don't leak into the web UI.

## Resumable runs — Vercel Workflow

A Slack thread can sit idle for an hour, then the user asks a follow-up. The web user can close the tab mid-stream and return five minutes later. The agent service must be able to **resume** an agent's state, not start over.

We commit to **Vercel Workflow DevKit (WDK)** + AI SDK v6 `DurableAgent` as the single resumability mechanism, used uniformly across all chat clients. Custom postgres checkpointing is rejected — it would re-implement what WDK already provides (step persistence, retries, crash recovery, replay) and adds a parallel state store to keep in sync with the canonical workflow state.

### How it maps onto our architecture

- **One workflow per conversation.** The workflow id is `(client_id, conversation_id)`. Starting a new turn looks up an existing workflow for that key and resumes; if none, starts a fresh run.
- **The agent runs inside the workflow.** Each agent in `agents/<id>/AGENT.md` is instantiated as a `DurableAgent` (AI SDK v6) by the harness. The agent's tool loop becomes a workflow with each tool call as a step — outputs are persisted, so if the function terminates mid-loop, the next request resumes from the last completed step instead of replaying the LLM call.
- **Streaming still works.** WDK supports streaming output from a workflow; the `/chat` SSE endpoint pipes the workflow's stream to the connected client. If the connection drops, the workflow keeps running; the next reconnect reattaches and replays buffered output.
- **Idle-resume is automatic.** The workflow's state lives in WDK's durable store. A Slack user asking a follow-up an hour later hits the same workflow id and the harness resumes the agent with full prior message history.

### What the harness handles

The harness wraps each AGENT.md-defined agent as a `DurableAgent` and exposes two entry points to the HTTP layer: `startTurn(conversationKey, userMessage)` and `resumeTurn(conversationKey)`. The Nitro `/chat` route calls into these — it does not know about Workflow internals. This keeps `apps/agent-service/src/http/` thin and makes the harness the single owner of durability semantics.

### What this rules out for v1

- **Cross-conversation persistence** (e.g. "remember this preference for next time we talk") — out of scope; that's memory, not run-resumability. Add only when there's a real need.
- **Multi-step user-initiated pauses inside a single turn.** WDK can pause/resume on external events; we don't yet need that pattern. Revisit if the Pipeline Manager grows long-running approval flows.

## Phased migration

Each phase is independently shippable. If we stop after any phase, the system still works.

### Phase 1 — Lift agents into `agent-service` (web-only, no behavior change)

- Stand up `packages/agent-harness` with the AGENT.md / SKILL.md loaders, ToolLoopAgent wrapper, and lifecycle tools. `apps/agent-worker` migrates onto it first (smallest surface — Planner + Executor) to validate the harness in isolation.
- Create `apps/agent-service` (Nitro). For each existing extension under `apps/web/src/extensions/<id>/`, write an `apps/agent-service/src/agents/<id>/AGENT.md` with the system prompt and `base_tools` list. Move the extension's `tools/` into `apps/agent-service/src/agents/<id>/tools/` (preserves agent ownership), and `skills/*.md` into `apps/agent-service/src/agents/<id>/skills/`. Lift `readCanvasState` (and any other genuinely cross-agent tool) into `apps/agent-service/src/tools/`. Delete the per-agent `agent.ts`, `register.ts`, and the `skills/index.ts` glue files — the harness replaces them.
- Service exposes `POST /chat` (SSE). Web client's existing chat hook now points at `agent-service` instead of `apps/web/api/chat`.
- **Wire up Vercel Workflow + `DurableAgent`** as the agent runtime (one workflow per `(client_id, conversation_id)`). Web hits the same workflow on reconnect, so closing the tab mid-stream and returning resumes cleanly. This is the foundation for Slack/Discord later — uniform durability across all clients from day one.
- **No render-intent layer yet** — `renderDagOverview` etc. still return json-render specs, the service forwards them, web renders as today. Slack remains impossible.
- Auth: web sends a short-lived bearer token from its NextAuth session.

Exit criteria: web app behaves identically. All existing E2E flows pass. `apps/web` no longer imports agent code. Every agent in the system is defined by exactly one AGENT.md plus its `skills/*.md`.

### Phase 2 — Introduce render-intents, ship Slack adapter

- Define `packages/render-intents` with types for the kinds web currently uses.
- In the service, render-shaped tools now emit render-intents (e.g. `renderDagOverview` → `{ kind: 'dag-overview', data: {...} }`). The current json-render-spec output moves into `packages/json-render-adapter`.
- Web client wraps incoming render-intents through `json-render-adapter` and renders into the existing canvas registry. **Behavior unchanged.**
- Stand up `apps/slack-bot`. It implements `block-kit-adapter` for whichever render-intents make sense in Slack (skip `definition-review` and `sql-editor`; deep-link to the web app instead). The bot reuses the same Workflow runtime stood up in Phase 1 — Slack threads map to workflow ids the same way web conversations do.

Exit criteria: a user can ask the Pipeline Manager about DAG status from Slack and get a Block Kit response. Web app unchanged.

### Phase 3 — Web migrates fully to render-intents

- Web's chat surface stops parsing json-render specs from the wire and instead consumes render-intents directly.
- `json-render-adapter` lives in `apps/web` only — it's now an internal detail, not a wire format.
- Canvas-state events (`readCanvasState`, `setState` actions) move into the chat-protocol as a separate event type.

Exit criteria: wire format is render-intents end-to-end. Adding a new client (Discord, CLI) is implementing one adapter.

## Open questions

Resolve before Phase 2 (render-intent design):

- **Granularity.** Is `dag-overview` one intent type with a rich shape, or several (`dag-list`, `dag-status-badge`, `dag-run-sparkline`) that compose? Composition is more flexible but harder for non-canvas clients to reason about.
- **Interactivity.** json-render lets the user click a DAG row to drill in. How does that interaction round-trip from Slack — a follow-up message? A button action? Each adapter answers this differently; decide if the protocol needs an explicit "intent-action" event type.
- **Stateful canvas vs. stateless intents.** Today the canvas accumulates state (selected row, expanded sections). Slack messages are append-only. Either intents carry the full state on each emit (stateless), or the protocol has an explicit "update part X of the existing render" event. Lean stateless for v1.

Resolve before Phase 3 (web migration):

- **What happens to `pipeJsonRender` and the JSONL streaming model?** Either it becomes the json-render adapter's internal implementation detail, or it's replaced with a higher-level intent stream. Probably the former.

## What this plan does NOT change

- **Worker-node agents** (Planner, Executor) stay in `apps/agent-worker`. They don't render — they take action — and their outputs go to postgres / Iceberg / Gitea, not to a chat surface.
- **Skill model.** SKILL.md format, owners gating, and the loader are unchanged. They live in `packages/agent-harness`. AGENT.md introduces the same convention (frontmatter + Markdown body) for agent definitions.
- **AI Gateway.** Vercel AI Gateway (`gateway('anthropic/claude-sonnet-4.6')`) keeps powering model calls. The service uses the same SDK.
- **Definitions DB / Gitea PR flow.** Unchanged. The service writes to the same postgres and Gitea that `apps/web` does today.

## Why Nitro (and why not stay in Next.js)

Three reasons Nitro fits better than "another Next.js app":

1. **No UI surface.** The service is API-only. Nitro is a server framework first; Next is a UI framework with a server attached. Less stuff to opt out of.
2. **Streaming primitives.** `eventStream`, `sendStream`, and the H3 event model are first-class for SSE. Next has these too but they're bolted onto App Router.
3. **Same ecosystem.** TypeScript, deploys to Vercel Fluid Compute, supports the AI SDK and AI Gateway with no extra glue.

If we'd stayed in Next.js for the service, the only meaningful loss would be an extra ~5 MB of UI dependencies in the bundle. Nitro is the cleaner choice but not a forcing function — the architectural decisions in this doc (render-intents, auth fan-out, resumable runs) are what matters.
