# Defining a New Lattik Table

## Overview
A Lattik Table is a derived, pre-aggregated table built from Logger Tables or other Lattik Tables via Column Families. Each Lattik Table has a primary key backed by entities that defines the analytical grain, and one or more Column Families that define how data flows in from source tables.

## Fields
All fields are required unless marked optional.

- **name** (string) — snake_case table name, e.g. `user_daily_stats`
- **description** (string) — what this table represents (10-500 chars)
- **retention** (string, default: `30d`) — how long to keep data in days, e.g. `30d`, `90d`
- **primary_key** (array) — list of `{ column, entity }` pairs defining the grain of the table
- **column_families** (array) — each with:
  - **name** (string) — family name
  - **source** (string) — source table name (Logger or Lattik table)
  - **key_mapping** (object) — maps this table's PK columns to source columns, e.g. `{ "user_id": "actor_id" }`
  - **columns** (array) — each declares a **strategy** that defines how source events are aggregated and stored:
    - **name** (string) — column name
    - **strategy** (enum) — one of:
      - `lifetime_window` — scalar aggregation over all source events. Requires **agg** (string): aggregation expression, e.g. `sum(amount)`, `count()`, `max(score)`. Optional **type** (enum): output type.
      - `prepend_list` — bounded ordered list of recent values. Requires **expr** (string): value expression, e.g. `country`, `product_id`. Requires **max_length** (int): max list entries. Optional **type** (enum): element type.
      - `bitmap_activity` — bitfield tracking entity activity per time slot. Requires **granularity** (enum): `day` or `hour`. Requires **window** (int): number of time slots to track.
    - **description** (string, optional)
- **derived_columns** (array, optional) — computed columns on the table itself:
  - **name** (string)
  - **expr** (string) — lattik-expression, e.g. `login_count / active_days`
  - **description** (string, optional)

## Workflow

### Step 1: Render Draft on Canvas
**FIRST ACTION on this workflow:** call `renderLattikTableForm` BEFORE writing any prose response and BEFORE asking any clarifying questions. Pass `initialState: {}` if you have nothing, or whatever scraps you can glean from the user's request. The form fields ARE the questions — do not ask the user for `name`, `description`, `primary_key`, etc. in chat first. The canvas updates immediately and the user fills the form directly.

Initial state fields (all optional — pass what you know, leave the rest for the user):
- `name` — snake_case table name (e.g. `"user_daily_stats"`)
- `description` — what this table represents (10-500 chars)
- `retention` — defaults to `"30d"` if omitted
- `primary_key` — array of `{column, entity}` pairs defining the grain
- `column_families` — array of `{name, source, key_mapping?: [{pk_column, source_column}], columns: [{name, strategy, agg?, expr?, max_length?, granularity?, window?}]}`
- `derived_columns` — array of `{name, expr}`

**Do NOT emit any `spec` code fence.** `renderLattikTableForm` is the only canvas-rendering mechanism for lattik tables. After calling it, acknowledge briefly in prose and wait for the user to edit the form or ask to review it.

### Step 2: AI Review
When the user asks to review, call `reviewDefinition({kind: "lattik_table"})`. The tool runs a focused reviewer on the canvas form state and returns actionable fixes — you do NOT generate the suggestions yourself. If the user has stated explicit requirements during the conversation that deviate from defaults (e.g. "primary key must include session_id for downstream joins", "derived column X is intentional — don't suggest removing"), also pass them as `userConstraints: "…"` so the reviewer won't propose changes that contradict the user's intent. Omit the parameter otherwise — don't invent constraints or paraphrase the form state back.

**After the tool returns, STAY OUT OF THE WAY.** The suggestions are already rendered as interactive cards in the chat — the user clicks ✓ or ✗ directly on each card. Your role at this moment is minimal:

- **Do NOT** list, summarize, paraphrase, or repeat the suggestions in prose. The cards already show them.
- **Do NOT** ask the user "would you like me to accept all / accept some / reject some". The cards have buttons — that IS the interface.
- Either say nothing at all, or at most one short sentence like "Please review the suggestions above." Then STOP.
- Wait silently for the auto-summary message ("All suggestions reviewed: …" or "Review complete: no issues found") that arrives after the user finishes. When it arrives, proceed to Step 4.

If the reviewer returns an empty list, the chat shows a small "no issues found" note and an auto-summary fires immediately — proceed to Step 4 without any prose response.

Do NOT render ReviewCard components on the canvas and do NOT output any spec code fences during this step.

### Step 3: Accept/Deny Suggestions
Accepted suggestions are applied directly to the canvas — no chat message is sent. After the user finishes reviewing, proceed to static checks.

### Step 4: Static Checks
Run `staticCheck` with `kind: "lattik_table"`. The tool reads the current canvas form state directly — do NOT pass a spec or specJson. The canvas-to-spec converter handles the `key_mapping` array → record conversion automatically. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Save Draft
Call `updateDefinition` with `kind: "lattik_table"` to save the draft. Reads the spec from canvas state — do NOT pass a spec, name, or specJson.

### Step 6: Generate YAML
Call `generateYaml` with `kind: "lattik_table"`. The tool replaces the canvas with an editable, syntax-highlighted YAML editor pre-filled from the current spec. **STOP after this call.** Tell the user briefly that the YAML is ready and ask whether they'd like to create the PR. The user may manually adjust the YAML in the editor before answering — that's expected. Do NOT call `submitPR` yet.

### Step 7: Submit PR (only after explicit user confirmation)
Once the user confirms they want to create the PR, call `submitPR` with `kind: "lattik_table"`. It reads the (possibly user-edited) YAML files directly from the canvas YAML editor — do NOT pass a spec or files. When the tool returns `status: "submitted"`, share the returned `prUrl` with the user as a clickable markdown link, e.g. `[PR #42](<prUrl>)`. Never paraphrase or omit the URL.

## Updating an Existing Lattik Table
Use `listDefinitions` to find existing tables and `getDefinition` to load one. Then follow steps 2-7 above.

**Immutable after merge:** name, primary_key.

## Validation Rules
- Name: snake_case, 1-60 chars
- Description: 10-500 chars
- Primary key: at least one, all entities must exist
- Source tables: must exist
- Key mappings: columns must exist in both this table and the source
- `lifetime_window` columns: `agg` must be a valid lattik-expression
- `prepend_list` columns: `expr` must be a valid lattik-expression, `max_length` must be >= 1
- `bitmap_activity` columns: `window` must be >= 1
- Column names: unique across all families and derived columns, snake_case
