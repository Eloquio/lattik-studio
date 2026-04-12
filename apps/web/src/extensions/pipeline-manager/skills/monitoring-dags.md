# Monitoring DAG Health

## Overview
Use this workflow to check the health of Lattik-managed Airflow DAGs — see which DAGs are active, drill into recent runs, inspect task failures, and view logs.

## Workflow

### Step 1: Render DAG Overview on Canvas
**FIRST ACTION on this workflow:** call `renderDagOverview` BEFORE writing any prose response and BEFORE asking any clarifying questions. The overview table IS the starting point — the user scans it visually and clicks into whatever needs attention.

After calling `renderDagOverview`, acknowledge briefly ("Here's the current DAG overview.") and wait. The user will either ask about a specific DAG or click a row on the canvas.

### Step 2: Show DAG Detail
When the user asks about a specific DAG (by name or by clicking a row), call `getDagDetail` with the `dagId`. Share the key facts:
- Schedule interval and whether it's paused
- Number of tasks and their types (wait vs. spark)
- The linked Lattik Table definition (column families, sources)

Then call `listDagRuns` to show the last 10 runs. Summarize the pattern: "Last 10 runs: 8 succeeded, 1 failed, 1 running."

### Step 3: Drill Into a Run
When the user asks about a specific run (or clicks one on the canvas), call `getTaskInstances` with the `dagId` and `dagRunId`. Then call `renderDagRunDetail` to show the task graph with per-task status on the canvas.

Summarize the run state: which tasks succeeded, which failed, how long each took.

### Step 4: View Task Logs
If a task failed, proactively offer to show its logs. When the user confirms (or clicks the log button on the canvas), call `getTaskLogs` with the `dagId`, `dagRunId`, and `taskId`.

For failed tasks, focus on:
- The last 50 lines (where the error usually is)
- Known error patterns: `OutOfMemoryError`, `TimeoutError`, `FileNotFoundException`, `Connection refused`
- The Spark exit code if it's a spark task

Summarize the root cause in one sentence, then show the relevant log excerpt.

### Step 5: Suggest Next Steps
Based on the failure pattern, suggest concrete next steps:
- **Sensor timeout** (wait task): "The source table wasn't ready. Check if the upstream DAG ran successfully, or trigger a manual run when the data lands."
- **Spark OOM**: "The Spark driver ran out of memory. Consider increasing `spark.driver.memory` in the table spec or reducing the backfill window."
- **Driver crash**: "The Spark driver exited with a non-zero code. Check the driver logs for stack traces."
- **S3/MinIO access error**: "The Spark job couldn't access S3. Verify the MinIO credentials in the `minio-credentials` secret."
- **Success**: "Everything looks healthy. No action needed."

## Notes
- Only Lattik-managed DAGs (tagged `lattik`) are shown. Unrelated DAGs like `example_dag` are filtered out.
- DAG runs are ordered newest-first by default.
- Task logs may be large — the tool truncates to the last 200 lines. If the user needs more, they can check the Airflow UI directly at http://localhost:8088.
