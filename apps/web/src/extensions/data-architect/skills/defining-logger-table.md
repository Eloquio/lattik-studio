# Defining a New Logger Table

## Overview
A Logger Table is a raw, append-only event table that captures events as they happen. Each row represents a single event occurrence with a timestamp. Logger Tables are the primary data ingestion point in the Lattik pipeline.

## Fields
- **name** (string, required) — snake_case table name, e.g. `user_login_events`
- **description** (string, required) — what events this table captures
- **event_timestamp** (string, required) — the column name used as the event timestamp
- **retention** (string, optional) — how long to keep data, e.g. `90d`, `1y`
- **dedup_window** (string, optional) — deduplication window, e.g. `1h`, `24h`
- **primary_key** (array, required) — list of `{ column, entity }` pairs defining the composite key
- **columns** (array, required) — column definitions, each with:
  - **name** (string, required) — column name
  - **type** (enum, required) — `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`
  - **entity** (string, optional) — entity this column references (for join keys)
  - **nullable** (boolean, optional) — whether the column can be null
  - **description** (string, optional) — column description

## Workflow (7 steps)

### Step 1 of 7: Gather Requirements
> Status: draft

Ask the user:
- What events does this table capture?
- What are the key entities involved?
- What columns are needed?
- What is the retention and dedup strategy?

### Step 2 of 7: Render Draft on Canvas
> Status: draft

Use `renderCanvas` to show with a StatusBadge:
1. The table metadata form (name, description, retention, dedup window)
2. A MockedTablePreview with auto-generated sample data
3. The ColumnList for column definitions

### Step 3 of 7: Collaborate on Definition
> Status: draft

The user may edit the form, add/remove columns, or adjust settings. Use `readCanvasState` to check edits. Update the canvas as changes are made.

### Step 4 of 7: AI Review
> Status: reviewing

When the user asks to review, use `reviewDefinition` and check:
- Are all primary key columns mapped to entities?
- Is the event_timestamp column present in the columns list?
- Are column types appropriate for their data?
- Are descriptions provided for all columns?
- Is the retention policy reasonable?
Render suggestions as ReviewCard components.

### Step 5 of 7: Accept/Deny Suggestions
> Status: reviewing

Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 6 of 7: Static Checks
> Status: checks-passed or checks-failed

Run `staticCheck` to validate table name, event_timestamp, primary keys, column names, types, and referential integrity.

### Step 7 of 7: Generate and Submit
> Status: pr-submitted

Use `updateDefinition` to save, then `submitPR` to create a PR.

## Validation Rules
- Table name must be snake_case, 1-60 chars
- Must have at least one primary key column
- event_timestamp column must exist with type `timestamp`
- All PK columns must reference existing entities
- Column names must be unique and snake_case
- Retention format: number + unit (d, h, m, y)
- Dedup window format: number + unit (d, h, m, s)

## Example
```yaml
name: user_login_events
description: Captures every user login event across all platforms
event_timestamp: event_ts
retention: 90d
dedup_window: 1h
primary_key:
  - column: user_id
    entity: user
  - column: session_id
    entity: session
columns:
  - name: user_id
    type: int64
    entity: user
    description: The user who logged in
  - name: session_id
    type: string
    entity: session
    description: The session identifier
  - name: event_ts
    type: timestamp
    description: When the login occurred
  - name: platform
    type: string
    description: Platform used (web, ios, android)
  - name: ip_address
    type: string
    nullable: true
    description: Client IP address
```
