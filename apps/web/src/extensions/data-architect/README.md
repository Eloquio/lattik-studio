# Data Architect Agent

The Data Architect is a specialist agent in Lattik Studio that helps users define data pipeline concepts through a chat + canvas workflow. It produces YAML definitions that get submitted as PRs.

## Architecture

```
User ←→ Chat ←→ Agent (Claude Haiku 4.5) ←→ Tools ←→ Canvas / DB / Gitea
```

The agent is a `ToolLoopAgent` (Vercel AI SDK v6) with a max of 10 tool steps per turn. It receives system instructions listing the available skills, and is told to always load the skill document first before starting any workflow.

### Key Behavior
- **Skill-driven:** The agent loads a skill markdown doc via `getSkill` before starting work. The skill doc is the source of truth for the workflow — the agent does not assume steps from memory.
- **Canvas-first:** Users work directly on canvas forms rather than answering questions in chat. The agent renders the form immediately, pre-populating any fields mentioned in the conversation.
- **Handoff protocol:** The agent uses `handback` to return control — `"pause"` for off-topic detours, `"complete"` when the user confirms they're done.

## Definition Types

| Kind | Description | Schema Key |
|------|-------------|------------|
| **Entity** | Business concept with a unique ID (e.g. user, game) | `entities` |
| **Dimension** | Attribute of an entity (e.g. user_home_country) | `dimensions` |
| **Logger Table** | Raw, append-only event table (client SDK: `@eloquio/lattik-logger`) | `log_tables` |
| **Lattik Table** | Derived, pre-aggregated table via Column Families | `tables` |
| **Metric** | Collection of aggregation expressions | `metrics` |

## Workflow (5 steps)

All five definition types follow the same workflow:

1. **Render Draft on Canvas** — Agent outputs a `spec` code fence with the built-in form component (e.g. `LoggerTableForm`), pre-populating state from the conversation. User edits directly on the canvas or chats with the agent.
2. **AI Review** — Agent calls `reviewDefinition`, which runs a separate reviewer LLM (Claude Sonnet) guided by the [`reviewing-definitions`](skills/reviewing-definitions.md) skill (review-only audience — not in the agent's skill menu). The tool returns actionable one-click fixes that render as `ReviewCard` components on the canvas.
3. **Accept/Deny Suggestions** — User accepts or denies each suggestion via canvas buttons. Agent reads decisions with `readCanvasState` and applies accepted changes.
4. **Static Checks** — Agent calls `staticCheck` which runs validation functions (naming, referential integrity, expression syntax). Failures return to canvas for fixes.
5. **Generate and Submit** — Agent calls `updateDefinition` to save the draft to the database, then `submitPR` to generate YAML and create a PR in Gitea/GitHub.

## Tools

| Tool | Purpose |
|------|---------|
| `getSkill` | Load a skill markdown document by ID |
| *(canvas rendering)* | Agent outputs `spec` code fences with JSONL patches — no dedicated tool |
| `readCanvasState` | Read the current form field values from the canvas |
| `reviewDefinition` | Generate AI review suggestions for a definition |
| `staticCheck` | Run validation (naming, referential, expression syntax) |
| `updateDefinition` | Save/update a definition draft in the database |
| `submitPR` | Generate YAML, create branch, commit, and open a PR |
| `listDefinitions` | List existing definitions, optionally filtered by kind |
| `getDefinition` | Fetch a specific definition by kind and name |
| `updatePipeline` | Update the full pipeline definition on the canvas |
| `handback` | Return control from the agent (`pause` or `complete`) |

## Canvas

The canvas uses `@json-render/react` for all rendering. The agent sends JSON specs, and the canvas renders them as interactive forms.

### Built-in Forms
Each definition type has a dedicated composite form component that handles the full UI:

- `EntityForm` — name, description, id_field, id_type
- `DimensionForm` — name, description, entity, source_table, source_column, data_type
- `LoggerTableForm` — name, description, retention, dedup_window, columns (with implicit columns shown)
- `LattikTableForm` — name, description, primary_key, column_families (with source/key mapping/agg), derived_columns
- `MetricForm` — name, description, calculations (expression + source_table)

### Primitive Components
Forms are built from these registered json-render components:

| Component | Purpose |
|-----------|---------|
| `Section` | Group related fields |
| `Heading` | Section title with optional subtitle |
| `TextInput` | Text field bound to state (supports title/subtitle variants, multiline) |
| `Select` | Dropdown bound to state |
| `Checkbox` | Boolean toggle |
| `ColumnList` | Editable list of columns with name + type |
| `MockedTablePreview` | Read-only table with auto-generated sample data |
| `DataTable` | Static read-only table |
| `ReviewCard` | Accept/deny card for AI suggestions |
| `StatusBadge` | Colored status pill (draft, reviewing, checks-passed, etc.) |
| `ExpressionEditor` | lattik-expression input with live validation |

### State Binding
All form inputs bind to json-render state paths (e.g. `/name`, `/description`, `/user_columns`). State is two-way: components read from state and write back via `onStateChange`. Canvas state is persisted to the database with the conversation and restored on page load.

### Canvas → Chat Actions
Composite forms can send messages to the chat panel via `useCanvasActions()` from `CanvasActionsContext`. For example, `LoggerTableForm` has a "Review Table" button that sends `"Review table"` to the chat, triggering the agent's review workflow. See `docs/canvas-rendering.md` for the full data flow and how to add this to new extensions.

## Validation

Three layers of validation run during static checks:

| Layer | Module | What it checks |
|-------|--------|----------------|
| **Naming** | `validation/naming.ts` | snake_case, reserved words, length limits, qualified names (`schema.table_name`), retention format (`<n>d`), dedup window format (`<n>h`) |
| **Referential** | `validation/referential.ts` | Entity exists, table exists, column exists in table, dimension exists — all checked against merged (production) definitions |
| **Expression** | `validation/expressions.ts` | lattik-expression parse validity for agg, expr, and derived column expressions |

### Render-time safeguard: unknown dimension bindings

Static check catches a logger-table column bound to a non-existent dimension at step 4 of the workflow, but by then the bad binding has already appeared on the canvas. `renderLoggerTableForm` therefore runs `stripUnknownDimensions` over its `initialState.user_columns` before building the spec — any `dimension` value that doesn't match a merged dimension name is removed, and the dropped bindings are surfaced in the tool result (`droppedDimensionBindings`) so the agent mentions them. The skill doc ([`defining-logger-table.md`](skills/defining-logger-table.md)) is the first line of defense: it requires the agent to call `listDefinitions({ kind: "dimension" })` and verify existence before setting any `dimension`; the render-time strip is belt-and-suspenders against LLM rule drift. Fails open on DB error so a transient hiccup can't block rendering.

## Schema

All definition types are defined as Zod schemas in `schema.ts`. The YAML output is a direct serialization of these schemas via `yaml-generator.ts` — no separate YAML schema exists.

### Column Classification

Logger table columns carry a typed `classification` object for sensitivity metadata. Each flag is an independent compliance concern with its own downstream handling (masking, access control, audit):

| Flag | Covers |
|------|--------|
| `pii` | Names, emails, IP addresses, device IDs |
| `phi` | HIPAA-protected health data |
| `financial` | Account numbers, card data |
| `credentials` | Tokens, passwords, secrets (should be rare) |

Spec shape (see `schema.ts` → `classificationSchema`):
```ts
classification?: { pii?: boolean; phi?: boolean; financial?: boolean; credentials?: boolean }
```

The canvas form state and the saved spec share this shape exactly — the `LoggerTableForm` popup renders one toggle pill per category, `canvas-to-spec.ts` passes the object through (stripping flags that are false/undefined), and `tags: ["pii"]`-style encodings are no longer produced. This means loading a saved spec back into the canvas round-trips correctly.

**Why a typed object instead of freeform tags:** a typo in a freeform `tags: ["pii"]` array is a silent policy failure; a typo in `classification.pii` is a type error. Classification is kept separate from `tags` — `tags` is reserved for non-compliance labels (`"high-cardinality"`, `"deprecated"`).

**Extensibility:** add a new compliance category by adding a field to `classificationSchema`. If a category ever needs sub-structure (e.g. direct vs quasi-identifier PII, per-flag masking strategy), widen the field from `boolean` to `boolean | { ... }` — the plain `true` stays valid as "yes, unspecified", so existing specs don't need to migrate.

**Downstream consumers** should key off the `isSensitive(classification)` helper (also in `schema.ts`) rather than inspecting individual flags, so adding a new category automatically broadens the definition of "sensitive" without touching every call site. Today no downstream system (ingest, Kafka, Spark drivers, lattik-stitch, Trino) reads this metadata — it's declarative only. Masking/redaction/access-control enforcement is future work.

## File Structure

```
data-architect/
├── agent.ts              Agent definition (ToolLoopAgent, instructions, tools)
├── register.ts           Extension registration
├── schema.ts             Zod schemas for all definition types
├── yaml-generator.ts     Spec → YAML serializer
├── canvas/
│   ├── data-architect-canvas.tsx   Root canvas component (provides CanvasActionsContext)
│   ├── catalog.ts                  json-render catalog definition
│   ├── registry.tsx                Component registry (all 16 components)
│   ├── logger-table-card.tsx       Logger table visualization card
│   ├── lattik-table-card.tsx       Lattik table visualization card
│   └── json-render/               json-render helpers
├── skills/
│   ├── index.ts                    Skill metadata and loader (SkillMeta.audience separates agent runbooks from reviewer policy)
│   ├── defining-entity.md          Entity workflow (audience: agent)
│   ├── defining-dimension.md       Dimension workflow (audience: agent)
│   ├── defining-logger-table.md    Logger table workflow (audience: agent)
│   ├── defining-lattik-table.md    Lattik table workflow (audience: agent)
│   ├── defining-metric.md          Metric workflow (audience: agent)
│   └── reviewing-definitions.md    Review policy for the review LLM (audience: reviewer — NOT shown to the agent's skill menu)
├── tools/
│   ├── get-skill.ts          Load skill documents
│   ├── read-canvas-state.ts  Read canvas form state
│   ├── review-definition.ts  AI review suggestions
│   ├── static-check.ts       Run validation
│   ├── update-definition.ts  Save drafts to DB
│   ├── submit-pr.ts          Generate YAML + create PR
│   ├── list-definitions.ts   List existing definitions
│   └── get-definition.ts     Fetch definition by name
└── validation/
    ├── index.ts              Validation router (delegates by kind)
    ├── naming.ts             Name, description, retention, dedup validation
    ├── referential.ts        Entity/table/column existence checks
    └── expressions.ts        lattik-expression syntax validation
```
