# Defining a New Lattik Table

## Overview
A Lattik Table is a derived, pre-aggregated table built from Logger Tables or other Lattik Tables via Column Families. Each Lattik Table has a primary key backed by entities that defines the analytical grain, and one or more Column Families that define how data flows in from source tables.

## Fields
All fields are required unless marked optional.

- **name** (string) — snake_case table name, e.g. `user_daily_stats`
- **description** (string) — what this table represents (10-500 chars)
- **primary_key** (array) — list of `{ column, entity }` pairs defining the grain of the table
- **column_families** (array) — each with:
  - **name** (string) — family name
  - **source** (string) — source table name (Logger or Lattik table)
  - **key_mapping** (object) — maps this table's PK columns to source columns, e.g. `{ "user_id": "actor_id" }`
  - **columns** (array) — each with:
    - **name** (string) — column name
    - **type** (enum, optional) — output type
    - **agg** (string, optional) — aggregation expression in lattik-expression syntax, e.g. `count()`, `sum(amount)`
    - **merge** (enum, optional) — merge strategy: `sum`, `max`, `min`, `replace`. Required when `agg` is set.
    - **expr** (string, optional) — expression in lattik-expression syntax, e.g. `last(status)`
    - **description** (string, optional)
- **derived_columns** (array, optional) — computed columns on the table itself:
  - **name** (string)
  - **expr** (string) — lattik-expression, e.g. `login_count / active_days`
  - **description** (string, optional)

## Workflow

### Step 1: Render Draft on Canvas
Use `renderCanvas` to show the definition form, pre-populating any fields the user has already provided in the conversation:
1. Table metadata form — TextInput fields for name and description, primary key editor
2. MockedTablePreview with sample data based on the schema
3. Column family definitions with source mappings and aggregations
4. Derived columns section

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Do the primary keys capture the right grain?
- Are all key mappings correct?
- Are aggregation expressions valid?
- Are merge strategies appropriate for each aggregation?
- Are derived column expressions valid?

Render suggestions as ReviewCard components.

### Step 3: Accept/Deny Suggestions
Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 4: Static Checks
Run `staticCheck` with the current definition. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Generate and Submit
Use `updateDefinition` to save, then `submitPR` to create a PR.

## Updating an Existing Lattik Table
Use `listDefinitions` to find existing tables and `getDefinition` to load one. Then follow steps 2-5 above.

**Immutable after merge:** name, primary_key.

## Validation Rules
- Name: snake_case, 1-60 chars
- Description: 10-500 chars
- Primary key: at least one, all entities must exist
- Source tables: must exist
- Key mappings: columns must exist in both this table and the source
- Aggregation/expression fields: valid lattik-expression syntax
- Columns with `agg`: must specify a `merge` strategy
- Column names: unique across all families and derived columns, snake_case
