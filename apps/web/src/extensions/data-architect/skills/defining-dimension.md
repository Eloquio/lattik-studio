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
Use `renderCanvas` to show the definition form, pre-populating any fields the user has already provided in the conversation. If the referenced entity doesn't exist yet, suggest defining it first.

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Does the referenced entity exist?
- Does the source table and column exist?
- Is the data type consistent with the source column?
- Is the naming convention followed (entity prefix)?

Render suggestions as ReviewCard components.

### Step 3: Accept/Deny Suggestions
Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 4: Static Checks
Run `staticCheck` with the current definition. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Generate and Submit
Use `updateDefinition` to save, then `submitPR` to create a PR.

## Updating an Existing Dimension
Use `listDefinitions` to find existing dimensions and `getDefinition` to load one. Then follow steps 2-5 above.

**Immutable after merge:** name, entity.

## Validation Rules
- Name: snake_case, 1-60 chars, should be prefixed with entity name
- Description: 10-500 chars
- Entity: must exist — define entities before referencing them
- Source table and column: must exist
- Data type: must be consistent with the source column
