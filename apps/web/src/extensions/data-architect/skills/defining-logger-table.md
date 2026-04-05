# Defining a New Logger Table

## Overview
A Logger Table is a raw, append-only event table that captures events as they happen. Each row represents a single event occurrence. Logger Tables are the primary data ingestion point — downstream Lattik Tables aggregate from them via Column Families.

Logger Tables have no primary key. Deduplication is handled within the dedup window by `event_id`. All logger tables are partitioned by `ds` and `hour`.

## Implicit Columns
Every logger table automatically includes these columns — they cannot be redefined:

| Column | Type | Purpose |
|--------|------|---------|
| `event_id` | string | Unique event identifier for deduplication |
| `event_timestamp` | timestamp | When the event occurred |
| `ds` | date | Date partition key (derived from ingestion time to handle late-arriving data) |
| `hour` | int32 | Hour partition key (derived from ingestion time) |

## Fields
All fields are required. Fields with a default are pre-populated but can be overridden.

- **name** (string) — `schema.table_name` format, e.g. `ingest.click_events`
- **description** (string) — what events this table captures (10-500 chars)
- **retention** (string, default: `30d`) — how long to keep data in days, e.g. `30d`, `90d`
- **dedup_window** (string, default: `1h`) — deduplication window in hours, e.g. `1h`, `24h`
- **columns** (array) — user-defined columns (the event payload). All user-defined columns are nullable. Each with:
  - **name** (string) — column name (must not collide with implicit columns)
  - **type** (enum) — `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`
  - **entity** (string, optional) — entity this column references, used as join keys for downstream Lattik Tables
  - **tags** (array of strings, optional) — freeform tags, e.g. `["pii", "high-cardinality"]`
  - **description** (string, optional) — column description

## Workflow

### Step 1: Render Draft on Canvas
Use `renderCanvas` to show the definition form, pre-populating any fields the user has already provided in the conversation:
1. Table metadata form — TextInput fields for name, description, retention (`30d`), and dedup_window (`1h`)
2. MockedTablePreview showing implicit and user-defined columns with sample data
3. ColumnList for user-defined columns

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Is the name in `schema.table_name` format?
- Do any columns collide with implicit column names?
- Are column types appropriate for their data?
- Are descriptions provided for all columns?
- Are entity references consistent with existing entities?

Render suggestions as ReviewCard components.

### Step 3: Accept/Deny Suggestions
Wait for user decisions. Use `readCanvasState` to check. Apply accepted changes.

### Step 4: Static Checks
Run `staticCheck` with the current definition. If checks fail, show errors and return to the canvas for fixes.

### Step 5: Generate and Submit
Use `updateDefinition` to save, then `submitPR` to create a PR.

## Updating an Existing Logger Table
Use `listDefinitions` to find existing tables and `getDefinition` to load one. Then follow steps 2-5 above.

**Immutable after merge:** name.

## Validation Rules
- Table name: `schema.table_name` format, max 60 chars
- Description: 10-500 chars
- Column names: unique, snake_case, no collisions with implicit columns
- Entity references: must point to existing entities
- Retention: `<number>d`, e.g. `30d`
- Dedup window: `<number>h`, e.g. `1h`
