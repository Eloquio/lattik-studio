# Defining a New Canonical Metric

## Overview
A Metric is a collection of aggregation expressions against Logger Tables or Lattik Tables. It defines *how* to aggregate, not the result. For example, DAU (Daily Active Users) can be calculated as `count_if(is_dau)` against a user-level Lattik table, or as `count_distinct(user_id)` against a different table. The actual aggregation is performed at query time, not during definition.

## Fields
- **name** (string, required) — snake_case identifier, e.g. `daily_active_users`
- **description** (string, required) — what this metric measures
- **calculations** (array, required) — one or more ways to compute this metric, each with:
  - **expression** (string, required) — aggregation expression in lattik-expression syntax, e.g. `count_if(is_dau)`, `count_distinct(user_id)`, `sum(revenue)`
  - **source_table** (string, required) — the Logger or Lattik table to aggregate against

## Workflow (7 steps)

### Step 1 of 7: Gather Requirements
> Status: draft

Ask the user:
- What does this metric measure?
- What tables contain the data needed?
- How should it be calculated? Are there multiple ways depending on the table?

### Step 2 of 7: Render Draft on Canvas
> Status: draft

Use `renderCanvas` to show with a StatusBadge:
1. Name and description fields
2. Calculations list — each with expression editor and source table selector

### Step 3 of 7: Collaborate on Definition
> Status: draft

The user may edit expressions or add/remove calculations. Use `readCanvasState` to check edits. Validate expression syntax using lattik-expression.

### Step 4 of 7: AI Review
> Status: reviewing

When the user asks to review, use `reviewDefinition` and check:
- Are the expressions semantically correct?
- Do the source tables exist?
- Are the referenced columns valid in the source tables?
- Do multiple calculations produce consistent results?
Render suggestions as ReviewCard components.

### Step 5 of 7: Accept/Deny Suggestions
> Status: reviewing

Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 6 of 7: Static Checks
> Status: checks-passed or checks-failed

Run `staticCheck` to validate metric name, calculations, expression syntax, source tables, and column references.

### Step 7 of 7: Generate and Submit
> Status: pr-submitted

Use `updateDefinition` to save, then `submitPR` to create a PR.

## Validation Rules
- Metric name must be snake_case, 1-60 chars
- Must have at least one calculation
- All expressions must be valid lattik-expression syntax
- All source tables must exist
- Column references in expressions must exist in the source table

## Example
```yaml
name: daily_active_users
description: Count of unique users who were active on a given day
calculations:
  - expression: "count_if(is_dau)"
    source_table: user_daily_stats
  - expression: "count_distinct(user_id)"
    source_table: user_login_events
```
