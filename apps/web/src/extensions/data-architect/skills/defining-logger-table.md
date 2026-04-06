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
| `ds` | string | Date partition key (derived from ingestion time to handle late-arriving data) |
| `hour` | string | Hour partition key (derived from ingestion time) |

## Fields
All fields are required. Fields with a default are pre-populated but can be overridden.

- **name** (string) — `schema.table_name` format, e.g. `ingest.click_events`
- **description** (string) — what events this table captures (10-500 chars)
- **retention** (string, default: `30d`) — how long to keep data in days, e.g. `30d`, `90d`
- **dedup_window** (string, default: `1h`) — deduplication window in hours, e.g. `1h`, `24h`
- **columns** (array) — user-defined columns (the event payload). All user-defined columns are nullable. Each with:
  - **name** (string) — column name (must not collide with implicit columns)
  - **type** (enum) — `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`
  - **dimension** (string, optional) — dimension this column maps to, used to resolve entity join keys for downstream Lattik Tables
  - **tags** (array of strings, optional) — freeform tags, e.g. `["pii", "high-cardinality"]`
  - **description** (string, optional) — column description

## Workflow

### Step 1: Render Draft on Canvas
Call `renderCanvas` with `form: "logger-table"`. This renders the built-in logger table form with:
- Inline editable table name and description
- Retention and dedup window fields (pre-filled with defaults)
- Columns table showing implicit columns (event_id, event_timestamp, ds, hour) and an "Add column" button for user-defined columns

The form state is managed automatically. Do NOT use specJson — just pass `{ form: "logger-table" }`.
Do NOT add a separate Heading element — the form already includes its own title.

### Step 2: AI Review
When the user asks to review, use `reviewDefinition` and check:
- Is the name in `schema.table_name` format?
- Do any columns collide with implicit column names?
- Are column types appropriate for their data?
- Are descriptions provided for all columns?
- Are dimension references consistent with existing dimensions?

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
- Dimension references: must point to existing dimensions
- Retention: `<number>d`, e.g. `30d`
- Dedup window: `<number>h`, e.g. `1h`
