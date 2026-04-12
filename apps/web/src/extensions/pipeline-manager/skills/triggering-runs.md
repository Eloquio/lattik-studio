# Triggering Runs & Backfills

> **Phase 2** — This skill will be expanded when action tools (`triggerDagRun`, `triggerBackfill`) are implemented.

## Overview
Use this workflow to manually trigger a DAG run for a specific logical date, or kick off a backfill across a date range.

## Manual Trigger

### Step 1: Select a DAG
Call `listDags` to show available DAGs. The user picks one by name or clicks on the canvas.

### Step 2: Confirm Parameters
Show the user what will happen:
- DAG ID
- Logical date (`ds`) they want to trigger for
- Any config overrides

Ask for explicit confirmation: "This will trigger `<dag_id>` for `<ds>`. Proceed?"

### Step 3: Trigger
After user confirms, call `triggerDagRun` with the `dagId` and `logicalDate`. Report the new run ID and state.

### Step 4: Monitor
Offer to watch the run: "Want me to check on it in a minute?" If yes, call `listDagRuns` and `getTaskInstances` to report progress.

## Backfill

### Step 1: Select a DAG
Same as manual trigger.

### Step 2: Configure Date Range
Ask for start and end dates. Show the backfill DAG's parallelism setting from the Lattik Table spec. Let the user override if needed.

### Step 3: Confirm and Trigger
Show a summary: DAG, date range, parallelism, estimated task count. Ask for explicit confirmation.

### Step 4: Monitor Progress
Track the backfill DAG run, showing task completion progress.
