# Agent Marketplace

## Overview

The Agent Marketplace is a full page (`/marketplace`) where users browse and enable specialized agents. Enabled agents become available through the Lattik Studio Assistant's handoff system.

## Agent Types

### First-party agents (code-defined)
- Shipped as code in `src/extensions/`
- Full power: custom tools, custom canvas rendering, complex logic
- Example: Data Architect with pipeline visualization

### Third-party agents (config-defined)
- Defined as data (stored in DB): system prompt, knowledge docs, tool config
- Use a standard canvas template renderer (charts, tables, markdown)
- Shared tool palette (query_lake, render_chart, render_table, etc.)
- No custom code deployment needed

Both types appear in the same marketplace UI.

## Data Model

### `agents` table (catalog)
- `id` — unique slug (e.g. "data-architect", "cost-anomaly-detector")
- `name` — display name
- `description` — short description for marketplace card
- `icon` — lucide icon name
- `category` — e.g. "Data Architecture", "Monitoring", "ML", "Analytics"
- `type` — "first-party" | "third-party"
- `config` — JSONB, for third-party: { system_prompt, knowledge[], tools[] }
- `authorId` — nullable, references users for third-party agents
- `published` — boolean
- `createdAt`, `updatedAt`

### `user_agents` table (enabled agents per user)
- `userId` — references users
- `agentId` — references agents
- `enabledAt` — timestamp

## Pages & Components

### `/marketplace` page
- Full page with the app shell (nav panel visible)
- Header: "Agent Marketplace" title
- Grid of agent cards showing: icon, name, description, category badge, enable/disable toggle
- Filter by category
- Search by name/description

### Agent card
- Icon + name + description
- Category badge
- "Enable" / "Enabled" toggle button
- Click card → detail view (modal or inline expand) with full description, knowledge preview, author info

## How It Connects

1. User visits `/marketplace`, browses agents, enables "Data Architect"
2. `user_agents` row created
3. Back in chat, user says "design a pipeline"
4. Assistant's system prompt includes only **enabled** agents in the handoff list
5. Assistant hands off to Data Architect
6. Chat route loads the agent config (code-defined or DB-defined) and streams response

## Handoff Integration

The chat route's `assistantSystemPrompt` currently hardcodes `getAllExtensions()`. This changes to:
1. Query `user_agents` JOIN `agents` for the current user
2. Build the "Available agents" list from enabled agents only
3. For third-party agents, construct the agent config from DB at request time

## Shared Tool Palette (for third-party agents)

Standard tools available to config-defined agents:
- `query_lake` — run SQL against the Data Lake
- `render_chart` — display a chart on the canvas
- `render_table` — display a data table on the canvas
- `render_markdown` — display formatted text on the canvas

## Implementation Order

1. Schema: `agents` and `user_agents` tables
2. Seed first-party agents into `agents` table (Data Architect)
3. `/marketplace` page with agent cards and enable/disable
4. Update chat route to query enabled agents instead of hardcoded registry
5. Third-party agent runtime (load config from DB, build tools/prompt)
6. Shared tool palette
7. Agent creation UI (for third-party authors)
