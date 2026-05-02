---
name: post-pipeline-pr-merge
description: Run all post-merge actions when a PR in the pipelines repo merges — branches per definition kind in the merge.
version: "0.1"
owners: [ExecutorAgent]
model: anthropic/claude-haiku-4.5
tools: [create_kafka_topic, emit_logger_proto, register_protobuf_schema, create_iceberg_table, start_logger_writer]
auto_approve: true
args:
  pr_url:
    type: string
    required: true
    description: URL of the merged PR.
  definitions:
    type: array
    required: true
    description: List of merged definitions, each `{id, kind, name, spec}`.
done: []
---

# Post-merge actions for a pipelines PR

You run after a PR in the `lattik/pipelines` repo merges. The user message includes:

- `pr_url` — the merged PR URL.
- `definitions` — every definition the PR merged. Each has a `kind` (`logger_table`, `entity`, `dimension`, `lattik_table`, `metric`) and the merged `spec`.

For each definition in `definitions`, run the steps for its `kind` below. Definitions with kinds not listed here have no post-merge actions yet — skip them silently.

## logger_table

For each `logger_table` definition, run these five tools in order. Pass `table_name` = `definition.name` and, where listed, `columns` = `definition.spec.columns` (the user-defined columns; do NOT include `event_id`, `event_timestamp`, `ds`, `hour` — those are implicit).

1. **`create_kafka_topic`** with `{ table_name }`. Idempotent — succeeds if the topic already exists.
2. **`emit_logger_proto`** with `{ table_name, columns }`. Writes the per-table .proto file into the lattik-logger package.
3. **`register_protobuf_schema`** with `{ table_name, columns }`. POSTs the same proto to Confluent Schema Registry under subject `logger.<table_name>-value` so the streaming writer can decode payloads at runtime. Idempotent.
4. **`create_iceberg_table`** with `{ table_name, columns }`. Issues `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` via Trino against the shared Iceberg catalog. Idempotent. The streaming writer in step 5 expects the destination table to exist.
5. **`start_logger_writer`** with `{ table_name }`. Renders and `kubectl apply`s a per-table Deployment running `lattik/logger-writer` against `logger.<table_name>` → `iceberg.<table_name>`. Replica count tracks the topic's partition count automatically. Idempotent — re-apply rolls the Deployment with any schema/partition changes.

If any tool returns `ok: false`, treat the run as **failed** at the end (see "Closing out") — but **keep going** through the remaining definitions and tools first so the human sees the full picture in one summary, not just the first failure. Track which tools failed so you can list them in the final result.

## entity / dimension / lattik_table / metric

No post-merge work yet. Don't call any tools for these — just note them in the final summary as "no actions".

## Closing out

After processing every definition, call `finishSkill` exactly once.

- If **every** tool call returned `ok: true`, call `finishSkill({ result: "<summary>" })`. The default status is `done`.
- If **any** tool call returned `ok: false`, call `finishSkill({ result: "<summary>", status: "failed" })`. The summary should list which tools failed (with the table they were called for) and any error / note from the failure payload. This is the right call even when the failure is a stub returning `ok: false, not_implemented: true` — the work isn't done, regardless of the reason.

Example success summary:

> `ingest.clicks` (logger_table): kafka topic created, proto emitted, writer started.
> `users` (entity): no actions.

Example failure summary (status = failed):

> `ingest.clicks` (logger_table): kafka topic created, proto emitted, schema registered, iceberg table created, writer Deployment FAILED (kubectl error: ...).
> `users` (entity): no actions.
