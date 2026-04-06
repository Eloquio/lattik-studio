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
Output a `spec` code fence rendering the `EntityForm` component with initial state pre-populated from the conversation. The form renders inline editable name/description, ID field, and ID type selector.

State keys: `name`, `description`, `id_field`, `id_type`.

Do NOT add a separate Heading element — the form already includes its own title.

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Is the name clear and follows naming conventions?
- Is the description meaningful?
- Does the id_field end with `_id`?
- Is the id_type appropriate for the use case?

Each suggestion MUST include `actions` with canvas state patches. The suggestions are rendered as interactive cards in the chat — do NOT render ReviewCard components on the canvas and do NOT output any spec code fences.

### Step 3: Accept/Deny Suggestions
Accepted suggestions are applied directly to the canvas — no chat message is sent. After the user finishes reviewing, proceed to static checks.

### Step 4: Static Checks
Run `staticCheck` with the current definition. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Generate and Submit
Use `updateDefinition` to save, then `submitPR` to create a PR.

## Updating an Existing Entity
Use `listDefinitions` to find existing entities and `getDefinition` to load one. Then follow steps 2-5 above.

**Immutable after merge:** name, id_type.

## Validation Rules
- Name: snake_case, 1-60 chars, no reserved words
- Description: 10-500 chars
- ID field: must end with `_id`, snake_case
- ID type: `int64` or `string`
