# Defining a New Logger Table

## Overview
A Logger Table is a raw, append-only event table that captures events as they happen. Each row represents a single event occurrence. Logger Tables are the primary data ingestion point — downstream Lattik Tables aggregate from them via Column Families.

Logger Tables have no primary key. Deduplication is handled within the dedup window by `event_id`. All logger tables are partitioned by `ds` and `hour`.

## Implicit Columns
Every logger table automatically includes these columns — they cannot be redefined:

| Column | Type | Purpose |
|--------|------|---------|
| `event_id` | string | Unique event identifier for deduplication |
| `event_timestamp` | timestamp | When the event occurred |
| `ds` | string | Date partition key (derived from ingestion time to handle late-arriving data) |
| `hour` | string | Hour partition key (derived from ingestion time) |

## Fields
All fields are required. Fields with a default are pre-populated but can be overridden.

- **name** (string) — `schema.table_name` format, e.g. `ingest.click_events`
- **description** (string) — what events this table captures (10-500 chars)
- **retention** (string, default: `30d`) — how long to keep data in days, e.g. `30d`, `90d`
- **dedup_window** (string, default: `1h`) — deduplication window in hours, e.g. `1h`, `24h`
- **columns** (array) — user-defined columns (the event payload). All user-defined columns are nullable. Each with:
  - **name** (string) — column name (must not collide with implicit columns)
  - **type** (enum) — `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`
  - **dimension** (string, optional) — dimension this column maps to, used to resolve entity join keys for downstream Lattik Tables
  - **classification** (object, optional) — sensitivity classification. Object with optional boolean flags, each a distinct compliance concern: `pii` (names, emails, IPs, device IDs), `phi` (HIPAA-protected health data), `financial` (account/card numbers), `credentials` (tokens, secrets). Set any that apply, e.g. `{ pii: true }` or `{ pii: true, phi: true }`. Downstream tooling (masking, access control, audit) keys off these flags.
  - **tags** (array of strings, optional) — freeform non-compliance labels, e.g. `["high-cardinality", "deprecated"]`. Do NOT put PII/PHI/etc. here — use `classification`.
  - **description** (string, optional) — column description

## Workflow

### Step 1: Render Draft on Canvas
**FIRST ACTION on this workflow:** call `renderLoggerTableForm` BEFORE writing any prose response and BEFORE asking any clarifying questions. Pass `initialState: {}` if you have nothing, or whatever scraps you can glean from the user's request. The form fields ARE the questions — do not ask the user for `name`, `user_columns`, etc. in chat first. The canvas updates immediately and the user fills the form directly.

Initial state fields (all optional — pass what you know, leave the rest for the user):
- `name` — qualified table name in `schema.table_name` format, e.g. `"ingest.click_events"`
- `description` — what events the table captures (10-500 chars)
- `retention` — defaults to `"30d"` if omitted
- `dedup_window` — defaults to `"1h"` if omitted
- `user_columns` — array of `{name, type, dimension?, description?, classification?}`. `classification` is an object with optional boolean flags `{pii, phi, financial, credentials}` — set any that apply. Implicit columns (`event_id`, `event_timestamp`, `ds`, `hour`) are added automatically by the form — do NOT include them here.

**Dimension bindings: only set `dimension` on a column when you have verified the dimension exists.** A `dimension` value on a column is a reference to a pre-existing Dimension definition. Before including ANY `dimension` value in `user_columns`, you MUST:
1. Call `listDefinitions({ kind: "dimension" })` and inspect the returned names.
2. Only set `dimension: "<name>"` on a column if `<name>` appears in that list.
3. If the dimension you want does not exist, OMIT the `dimension` field entirely on that column — do NOT invent a name, do NOT use a placeholder, and do NOT set it to the column's own name hoping a matching dimension will exist later.

After rendering, briefly tell the user which columns would benefit from a dimension binding so they can define those dimensions first if they want. The render tool also strips unknown dimension references as a safeguard and returns them in its result, but the agent is the first line of defense — do not rely on the strip.

**Do NOT emit any `spec` code fence.** `renderLoggerTableForm` is the only canvas-rendering mechanism for logger tables. After calling it, acknowledge briefly in prose ("I've set up the click_events form with one user_id column") and wait for the user to edit the form or ask to review it.

### Step 2: AI Review
When the user asks to review, call `reviewDefinition({kind: "logger_table"})`. The tool runs a focused reviewer on the canvas form state and returns actionable fixes — you do NOT generate the suggestions yourself. If the user has stated explicit requirements during the conversation that deviate from defaults (e.g. "keep 90-day retention for compliance", "user_id must stay a string — upstream producer confirmed"), also pass them as `userConstraints: "…"` so the reviewer won't propose changes that contradict the user's intent. Omit the parameter otherwise — don't invent constraints or paraphrase the form state back.

**After the tool returns, STAY OUT OF THE WAY.** The suggestions are already rendered as interactive cards in the chat — the user clicks ✓ or ✗ directly on each card. Your role at this moment is minimal:

- **Do NOT** list, summarize, paraphrase, or repeat the suggestions in prose. The cards already show them.
- **Do NOT** ask the user "would you like me to accept all / accept some / reject some". The cards have buttons — that IS the interface.
- Either say nothing at all, or at most one short sentence like "Please review the suggestions above." Then STOP.
- Wait silently for the auto-summary message ("All suggestions reviewed: …" or "Review complete: no issues found") that arrives after the user finishes. When it arrives, proceed to Step 4.

If the reviewer returns an empty list, the chat shows a small "no issues found" note and an auto-summary fires immediately — proceed to Step 4 without any prose response.

Do NOT render ReviewCard components on the canvas and do NOT output any spec code fences during this step.

### Step 3: Accept/Deny Suggestions
The user accepts or denies each suggestion via buttons in the chat. Accepted suggestions are applied directly to the canvas — no chat message is sent. After the user finishes reviewing, proceed to static checks.

### Step 4: Static Checks
Run `staticCheck` with `kind: "logger_table"`. The tool reads the current canvas form state directly — do NOT pass a spec or specJson. The canvas-to-spec converter handles the `user_columns` → `columns` rename automatically. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Save Draft
Call `updateDefinition` with `kind: "logger_table"` to save the draft. Reads the spec from canvas state — do NOT pass a spec, name, or specJson.

### Step 6: Generate YAML
Call `generateYaml` with `kind: "logger_table"`. The tool replaces the canvas with an editable, syntax-highlighted YAML editor pre-filled from the current spec. **STOP after this call.** Tell the user briefly that the YAML is ready and ask whether they'd like to create the PR. The user may manually adjust the YAML in the editor before answering — that's expected. Do NOT call `submitPR` yet.

### Step 7: Submit PR (only after explicit user confirmation)
Once the user confirms they want to create the PR, call `submitPR` with `kind: "logger_table"`. It reads the (possibly user-edited) YAML files directly from the canvas YAML editor — do NOT pass a spec or files. When the tool returns `status: "submitted"`, share the returned `prUrl` with the user as a clickable markdown link, e.g. `[PR #42](<prUrl>)`. Never paraphrase or omit the URL.

## Updating an Existing Logger Table
Use `listDefinitions` to find existing tables and `getDefinition` to load one. Then follow steps 2-7 above.

**Immutable after merge:** name.

## Validation Rules
- Table name: `schema.table_name` format, max 60 chars
- Description: 10-500 chars
- Column names: unique, snake_case, no collisions with implicit columns
- Dimension references: must point to existing dimensions
- Retention: `<number>d`, e.g. `30d`
- Dedup window: `<number>h`, e.g. `1h`
