# Defining a New Lattik Table

## Overview
A Lattik Table (super wide table) is a derived/aggregated table built from Logger Tables or other Lattik Tables via Column Families. It materializes pre-aggregated data for fast analytical queries. Each Lattik Table has a primary key backed by entities and one or more Column Families that define how data flows in from source tables.

## Fields
- **name** (string, required) — snake_case table name, e.g. `user_daily_stats`
- **description** (string, required) — what this table represents
- **primary_key** (array, required) — list of `{ column, entity }` pairs
- **column_families** (array, required) — each with:
  - **name** (string, required) — family name
  - **source** (string, required) — source table name (Logger or Lattik table)
  - **key_mapping** (object, required) — maps this table's PK columns to the source columns, e.g. `{ "user_id": "actor_id" }`
  - **columns** (array, required) — each with:
    - **name** (string, required) — column name
    - **type** (enum, optional) — output type
    - **agg** (string, optional) — aggregation expression, e.g. `count()`, `sum(amount)`. Uses lattik-expression syntax.
    - **merge** (enum, optional) — merge strategy: `sum`, `max`, `min`, `replace`
    - **expr** (string, optional) — expression, e.g. `last(status)`. Uses lattik-expression syntax.
    - **description** (string, optional)
- **derived_columns** (array, optional) — computed columns on the table itself:
  - **name** (string, required)
  - **expr** (string, required) — lattik-expression, e.g. `login_count / active_days`
  - **description** (string, optional)

## Workflow (7 steps)

### Step 1 of 7: Gather Requirements
> Status: draft

Ask the user:
- What analytical questions should this table answer?
- What entities form the primary key (the grain of the table)?
- What source tables provide the data?
- What aggregations and derived metrics are needed?

### Step 2 of 7: Render Draft on Canvas
> Status: draft

Use `renderCanvas` to show with a StatusBadge:
1. Table metadata form (name, description, primary keys)
2. A MockedTablePreview with auto-generated sample data based on the schema
3. Column family definitions with their source mappings and aggregations
4. Derived columns section

### Step 3 of 7: Collaborate on Definition
> Status: draft

The user may edit column families, adjust aggregations, or add derived columns. Use `readCanvasState` to check edits. For columns with `agg` or `expr` fields, validate the expression syntax using lattik-expression.

### Step 4 of 7: AI Review
> Status: reviewing

When the user asks to review, use `reviewDefinition` and check:
- Do the primary keys capture the right grain?
- Are all key mappings correct?
- Are aggregation expressions valid?
- Are merge strategies appropriate for each aggregation?
- Are derived column expressions valid?
Render suggestions as ReviewCard components.

### Step 5 of 7: Accept/Deny Suggestions
> Status: reviewing

Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 6 of 7: Static Checks
> Status: checks-passed or checks-failed

Run `staticCheck` to validate table name, PK entities, source tables, key mappings, expression syntax, column uniqueness, and merge strategies.

### Step 7 of 7: Generate and Submit
> Status: pr-submitted

Use `updateDefinition` to save, then `submitPR` to create a PR.

## Validation Rules
- Table name must be snake_case, 1-60 chars
- Must have at least one primary key
- Primary key entities must exist
- Source tables must exist
- Key mapping columns must exist in both this table and the source
- Aggregation and expression fields must be valid lattik-expression syntax
- Columns with `agg` must specify a `merge` strategy
- Column names unique across all families + derived columns

## Example
```yaml
name: user_daily_stats
description: Daily aggregated statistics per user for login and engagement metrics
primary_key:
  - column: user_id
    entity: user
column_families:
  - name: login_metrics
    source: user_login_events
    key_mapping:
      user_id: user_id
    columns:
      - name: login_count
        agg: "count()"
        merge: sum
        description: Total number of logins
      - name: last_platform
        expr: "last(platform)"
        description: Most recent login platform
  - name: purchase_metrics
    source: user_purchase_events
    key_mapping:
      user_id: buyer_id
    columns:
      - name: total_spend
        agg: "sum(amount)"
        merge: sum
        description: Total purchase amount
derived_columns:
  - name: avg_spend_per_login
    expr: "total_spend / login_count"
    description: Average spend per login session
```
