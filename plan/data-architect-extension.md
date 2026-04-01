# Data Architect Extension + Extension Framework

## Context

Lattik Studio needs its first extension: **Data Architect** — an agent that designs pipeline architectures through chat and renders them on the canvas. This also requires building the extension framework itself so future extensions (Root Cause Analysis, etc.) can plug in naturally.

## What the Data Architect Does

Designs three artifact types through conversation:
- **Logger Tables** — raw, append-only event tables (columns, PKs, retention, dedup)
- **Lattik Tables** — derived/aggregated tables built via Column Families (sources, key mappings, aggregations, derived columns)
- **Entities** — canonical dimensions (name, type, description) that serve as semantic glue across all tables

These form a `PipelineDefinition` (version 1 YAML schema).

---

## Implementation Plan

### Phase 1: Extension Framework

**New files:**

| File | Purpose |
|------|---------|
| `src/extensions/types.ts` | Core types: `ExtensionId`, `ExtensionAgent`, `ExtensionDefinition` |
| `src/extensions/registry.ts` | Map-based registry: `registerExtension()`, `getExtension()`, `getAllExtensions()` |
| `src/extensions/agents/index.ts` | `getExtensionAgent(id)` — server-side agent lookup |
| `src/extensions/index.ts` | Registers all built-in extensions |

**Modify existing:**

| File | Change |
|------|--------|
| `src/app/page.tsx` | Add `activeExtensionId` state, pass to ChatPanel + CanvasPanel |
| `src/app/api/chat/route.ts` | Read `extensionId` from body, look up agent, pass system prompt + tools to `streamText` |
| `src/components/chat/chat-panel.tsx` | Accept `activeExtensionId` prop, pass as `body: { extensionId }` to `useChat`, update header |

**Routing mechanism:** `useChat({ body: { extensionId } })` sends the active extension ID on every request. The chat route looks it up and configures `streamText` with the extension's system prompt and tools. No `extensionId` → default behavior (no tools).

### Phase 2: Data Architect Agent

**New files:**

| File | Purpose |
|------|---------|
| `src/extensions/data-architect/schema.ts` | Zod schemas for Entity, LoggerTable, LattikTable, PipelineDefinition |
| `src/extensions/agents/data-architect.ts` | System prompt + tools (`updatePipeline`, `generateYaml`) |

**Tools:**
- **`updatePipeline`** — agent calls with full `PipelineDefinition`. Result streams to client and updates canvas state.
- **`generateYaml`** — serializes pipeline to YAML for export.

**Dependencies to add:** `zod` (for tool schemas)

### Phase 3: Canvas Pipeline Visualization

**New files:**

| File | Purpose |
|------|---------|
| `src/hooks/use-pipeline.ts` | Extracts latest pipeline state from chat message tool results |
| `src/extensions/data-architect/canvas/data-architect-canvas.tsx` | Main canvas component — lays out entities, logger tables, lattik tables |
| `src/extensions/data-architect/canvas/entity-chip.tsx` | Pill/badge for an entity (name + type) |
| `src/extensions/data-architect/canvas/logger-table-card.tsx` | Card showing columns, PKs, retention, dedup |
| `src/extensions/data-architect/canvas/lattik-table-card.tsx` | Card showing column families, aggregations, derived columns |
| `src/extensions/data-architect/canvas/pipeline-flow.tsx` | SVG arrows connecting entities → tables → lattik tables |
| `src/extensions/data-architect/canvas/pipeline-empty-state.tsx` | Empty state: "Start designing your pipeline in the chat" |

**Modify existing:**

| File | Change |
|------|--------|
| `src/app/page.tsx` | Wire `usePipeline` hook, pass pipeline state to canvas |
| `src/components/canvas/canvas-panel.tsx` | Accept `canvasState` + `activeExtensionId`, render `DataArchitectCanvas` |

**Canvas layout:** Simple CSS column layout (Entities → Logger Tables → Lattik Tables) with SVG connection lines. No graph library needed yet — upgrade to React Flow later if drag/drop is needed.

### Phase 4: Nav Panel Extension Switcher

| File | Change |
|------|--------|
| `src/components/layout/nav-panel.tsx` | List registered extensions, highlight active, handle switching |

---

## Key Design Decisions

- **Single `/api/chat` route** with `extensionId` routing (not per-extension routes) — simpler, matches `useChat` model
- **Tool results as canvas state** — pipeline definition is naturally the output of the `updatePipeline` tool call; no extra streaming channel needed
- **No pipeline DB persistence yet** — state lives in chat messages as tool results. Add a `pipelines` table later when needed.
- **CSS layout + SVG arrows** for pipeline viz — pragmatic first pass; swap to React Flow if needed

## Verification

1. Start dev server, sign in
2. Chat should route to Data Architect agent by default
3. Ask "Design a pipeline for tracking user signups" → agent responds with architecture, calls `updatePipeline`
4. Canvas should open and render entities, logger tables, lattik tables
5. Ask "Generate the YAML" → agent calls `generateYaml`, returns YAML in chat
6. Build passes: `pnpm build`
