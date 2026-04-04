# Defining a New Canonical Dimension

## Overview
A Dimension is an attribute of an Entity. For example, `user_home_country` is a Dimension of the `user` Entity. An Entity can have multiple Dimensions (e.g. `user_home_country`, `user_resident_country`). A Dimension always maps to a column in a Logger Table or Lattik Table.

## Fields
- **name** (string, required) — snake_case identifier, e.g. `user_home_country`
- **description** (string, required) — what this dimension represents
- **entity** (string, required) — the Entity this dimension belongs to, e.g. `user`
- **source_table** (string, required) — the Logger or Lattik table containing this dimension's data
- **source_column** (string, required) — the column in the source table
- **data_type** (enum, required) — column type: `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`

## Workflow (7 steps)

### Step 1 of 7: Gather Requirements
> Status: draft

Ask the user:
- Which Entity does this dimension belong to?
- What attribute does it describe?
- Where does the data come from (which table and column)?

### Step 2 of 7: Render Draft on Canvas
> Status: draft

Use `renderCanvas` to show the dimension definition form with a StatusBadge. If the entity doesn't exist yet, suggest defining it first.

### Step 3 of 7: Collaborate on Definition
> Status: draft

The user may edit fields on the canvas or request changes via chat. Use `readCanvasState` to check edits. Update accordingly.

### Step 4 of 7: AI Review
> Status: reviewing

When the user asks to review, use `reviewDefinition` and check:
- Does the referenced Entity exist?
- Does the source table and column exist?
- Is the data type consistent with the source column?
- Is the naming convention followed (entity prefix)?
Render suggestions as ReviewCard components.

### Step 5 of 7: Accept/Deny Suggestions
> Status: reviewing

Wait for user decisions on each suggestion. Use `readCanvasState` to check. Apply accepted changes.

### Step 6 of 7: Static Checks
> Status: checks-passed or checks-failed

Run `staticCheck` to validate naming, entity existence, source table/column existence, data type consistency.

### Step 7 of 7: Generate and Submit
> Status: pr-submitted

Use `updateDefinition` to save, then `submitPR` to create a PR.

## Validation Rules
- Dimension name must be snake_case, 1-60 chars
- Dimension name should be prefixed with the entity name (e.g. `user_home_country` for entity `user`)
- Referenced entity must exist
- Source table and column must exist
- Data type must be consistent with the source column

## Example
```yaml
name: user_home_country
description: The home country of the user based on their registration address
entity: user
source_table: user_profile
source_column: home_country
data_type: string
```
