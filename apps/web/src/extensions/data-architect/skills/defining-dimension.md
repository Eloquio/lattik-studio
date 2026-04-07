# Defining a New Canonical Dimension

## Overview
A Dimension is an attribute of an Entity. For example, `user_home_country` is a Dimension of the `user` Entity. An Entity can have multiple Dimensions (e.g. `user_home_country`, `user_resident_country`). A Dimension always maps to a column in a Logger Table or Lattik Table.

## Fields
All fields are required.

- **name** (string) — snake_case identifier, prefixed with the entity name, e.g. `user_home_country`
- **description** (string) — what this dimension represents (10-500 chars)
- **entity** (string) — the Entity this dimension belongs to, e.g. `user`
- **source_table** (string) — the Logger or Lattik table containing this dimension's data
- **source_column** (string) — the column in the source table
- **data_type** (enum) — `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`

## Workflow

### Step 1: Render Draft on Canvas
Call `renderDimensionForm({initialState: {...}})` with whatever values you can glean from the user's request. The tool builds the canonical form spec server-side and the canvas updates immediately. If the referenced entity doesn't exist yet, suggest defining it first.

Initial state fields (all optional — pass what you know, leave the rest for the user):
- `name` — snake_case dimension identifier, typically prefixed with the entity name (e.g. `"user_home_country"`)
- `description` — what this dimension represents (10-500 chars)
- `entity` — entity this dimension belongs to
- `source_table` — Logger or Lattik table containing the dimension's data
- `source_column` — column in the source table
- `data_type` — one of the column types

**Do NOT emit any `spec` code fence.** `renderDimensionForm` is the only canvas-rendering mechanism for dimensions. After calling it, acknowledge briefly in prose and wait for the user to edit the form or ask to review it.

### Step 2: AI Review
When the user asks to review, call `reviewDefinition({kind: "dimension"})`. The tool runs a focused reviewer on the canvas form state and returns actionable fixes — you do NOT generate the suggestions yourself.

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
Run `staticCheck` with `kind: "dimension"`. The tool reads the current canvas form state directly — do NOT pass a spec or specJson. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Save Draft
Call `updateDefinition` with `kind: "dimension"` to save the draft. Reads the spec from canvas state — do NOT pass a spec, name, or specJson.

### Step 6: Generate YAML
Call `generateYaml` with `kind: "dimension"`. The tool replaces the canvas with an editable, syntax-highlighted YAML editor pre-filled from the current spec. **STOP after this call.** Tell the user briefly that the YAML is ready and ask whether they'd like to create the PR. The user may manually adjust the YAML in the editor before answering — that's expected. Do NOT call `submitPR` yet.

### Step 7: Submit PR (only after explicit user confirmation)
Once the user confirms they want to create the PR, call `submitPR` with `kind: "dimension"`. It reads the (possibly user-edited) YAML files directly from the canvas YAML editor — do NOT pass a spec or files. When the tool returns `status: "submitted"`, share the returned `prUrl` with the user as a clickable markdown link, e.g. `[PR #42](<prUrl>)`. Never paraphrase or omit the URL.

## Updating an Existing Dimension
Use `listDefinitions` to find existing dimensions and `getDefinition` to load one. Then follow steps 2-7 above.

**Immutable after merge:** name, entity.

## Validation Rules
- Name: snake_case, 1-60 chars, should be prefixed with entity name
- Description: 10-500 chars
- Entity: must exist — define entities before referencing them
- Source table and column: must exist
- Data type: must be consistent with the source column
