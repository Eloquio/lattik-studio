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
Use `renderCanvas` to show the definition form, pre-populating any fields the user has already provided in the conversation:
1. TextInput fields for name and description
2. Calculations list — each with an ExpressionEditor and source table selector

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Are the expressions semantically correct?
- Do the source tables exist?
- Are the referenced columns valid in the source tables?
- Do multiple calculations produce consistent results?

Render suggestions as ReviewCard components.

### Step 3: Accept/Deny Suggestions
Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

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
