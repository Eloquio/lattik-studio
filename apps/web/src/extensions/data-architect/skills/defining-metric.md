# Defining a New Canonical Metric

## Overview
A Metric is a collection of aggregation expressions against Logger Tables or Lattik Tables. It defines *how* to aggregate, not the result. For example, DAU can be calculated as `count_if(is_dau)` against a user-level Lattik table, or as `count_distinct(user_id)` against a Logger table. The actual aggregation is performed at query time, not during definition.

## Fields
All fields are required.

- **name** (string) — snake_case identifier, e.g. `daily_active_users`
- **description** (string) — what this metric measures (10-500 chars)
- **calculations** (array) — one or more ways to compute this metric, each with:
  - **expression** (string) — aggregation expression in lattik-expression syntax, e.g. `count_if(is_dau)`, `count_distinct(user_id)`, `sum(revenue)`
  - **source_table** (string) — the Logger or Lattik table to aggregate against

## Workflow

### Step 1: Render Draft on Canvas
Output a `spec` code fence rendering the `MetricForm` component with initial state pre-populated from the conversation. The form renders inline editable name/description and an interactive calculations list.

State keys: `name`, `description`, `calculations[]`.

Do NOT add a separate Heading element — the form already includes its own title.

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Are the expressions semantically correct?
- Do the source tables exist?
- Are the referenced columns valid in the source tables?
- Do multiple calculations produce consistent results?

The suggestions are rendered as interactive cards in the chat panel — do NOT render ReviewCard components on the canvas.

### Step 3: Accept/Deny Suggestions
The user will accept or deny each suggestion individually. Apply each accepted change to the definition on the canvas right away by outputting an updated spec code fence. Denied suggestions require no action.

### Step 4: Static Checks
Run `staticCheck` with the current definition. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Generate and Submit
Use `updateDefinition` to save, then `submitPR` to create a PR.

## Updating an Existing Metric
Use `listDefinitions` to find existing metrics and `getDefinition` to load one. Then follow steps 2-5 above.

**Immutable after merge:** name.

## Validation Rules
- Name: snake_case, 1-60 chars
- Description: 10-500 chars
- Calculations: at least one
- Expressions: valid lattik-expression syntax
- Source tables: must exist
