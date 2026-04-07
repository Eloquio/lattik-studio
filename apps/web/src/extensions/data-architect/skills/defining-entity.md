# Defining a New Entity

## Overview
An Entity is a business concept that uniquely identifies something in the system — like a user, a game, or a session. Entities serve as join keys across Logger Tables and Lattik Tables.

## Fields
All fields are required.

- **name** (string) — snake_case identifier, e.g. `user`, `game`, `session`
- **description** (string) — what this entity represents in the business domain (10-500 chars)
- **id_field** (string) — the column name used to identify this entity, must end with `_id`, e.g. `user_id`
- **id_type** (enum) — data type of the ID field: `int64` or `string`

## Workflow

### Step 1: Render Draft on Canvas
**FIRST ACTION on this workflow:** call `renderEntityForm` BEFORE writing any prose response and BEFORE asking any clarifying questions. Pass `initialState: {}` if you have nothing, or whatever scraps you can glean from the user's request. The form fields ARE the questions — do not ask the user for `name`, `id_field`, `id_type`, etc. in chat first. The canvas updates immediately and the user fills the form directly.

Initial state fields (all optional — pass what you know, leave the rest for the user):
- `name` — snake_case entity identifier (e.g. `"user"`, `"game"`)
- `description` — business description (10-500 chars)
- `id_field` — must end with `_id` (e.g. `"user_id"`)
- `id_type` — `"int64"` or `"string"`

**Do NOT emit any `spec` code fence.** `renderEntityForm` is the only canvas-rendering mechanism for entities. After calling it, acknowledge briefly in prose and wait for the user to edit the form or ask to review it.

### Step 2: AI Review
When the user asks to review, call `reviewDefinition({kind: "entity"})`. The tool runs a focused reviewer on the canvas form state and returns actionable fixes — you do NOT generate the suggestions yourself.

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
Run `staticCheck` with `kind: "entity"`. The tool reads the current canvas form state directly — do NOT pass a spec or specJson. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Save Draft
Call `updateDefinition` with `kind: "entity"` to save the draft. Reads the spec from canvas state — do NOT pass a spec, name, or specJson.

### Step 6: Generate YAML
Call `generateYaml` with `kind: "entity"`. The tool replaces the canvas with an editable, syntax-highlighted YAML editor pre-filled from the current spec. **STOP after this call.** Tell the user briefly that the YAML is ready and ask whether they'd like to create the PR. The user may manually adjust the YAML in the editor before answering — that's expected. Do NOT call `submitPR` yet.

### Step 7: Submit PR (only after explicit user confirmation)
Once the user confirms they want to create the PR, call `submitPR` with `kind: "entity"`. It reads the (possibly user-edited) YAML files directly from the canvas YAML editor — do NOT pass a spec or files. When the tool returns `status: "submitted"`, share the returned `prUrl` with the user as a clickable markdown link, e.g. `[PR #42](<prUrl>)`. Never paraphrase or omit the URL.

## Updating an Existing Entity
Use `listDefinitions` to find existing entities and `getDefinition` to load one. Then follow steps 2-7 above.

**Immutable after merge:** name, id_type.

## Validation Rules
- Name: snake_case, 1-60 chars, no reserved words
- Description: 10-500 chars
- ID field: must end with `_id`, snake_case
- ID type: `int64` or `string`
