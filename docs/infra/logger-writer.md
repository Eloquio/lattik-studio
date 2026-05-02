# Logger Writer

The **logger-writer** is the per-table Kafka → Iceberg consumer that closes the loop between the ingest service and the warehouse. One Deployment per Logger Table; each pod subscribes to `logger.<table>`, decodes envelopes, and appends rows to `iceberg.<schema>.<table>`.

## Where it sits

```
app SDK (lattik-logger)
    │  POST envelope (Protobuf)
    ▼
apps/ingest (Go)                 — dedups by event_id, routes by envelope.table
    │  produce → Kafka topic `logger.<table>`
    ▼
apps/logger-writer (Rust)        — one Deployment per table, this doc
    │  iceberg.fast_append()
    ▼
Iceberg REST catalog + MinIO
```

## Image

- **Source:** [apps/logger-writer/](../../apps/logger-writer/) (Rust crate; rdkafka, iceberg-rust 0.9, arrow 57, parquet 57, prost).
- **Image:** `lattik/logger-writer:dev`.
- **Build:** `pnpm logger-writer:image-build` (multi-stage Dockerfile with cargo-chef so warm rebuilds skip dep recompilation).
- **Build prereq on host:** `protoc` (`brew install protobuf` on macOS) — needed by prost-build for the static Envelope schema.

## Deployment shape

One `Deployment` per Logger Table in the `workloads` namespace, applied by the [`start_logger_writer`](../../apps/agent-worker/src/tools/start-logger-writer.ts) tool as part of the `post-pipeline-pr-merge` workflow skill. Manifest template: [k8s/logger-writer/deployment-template.yaml](../../k8s/logger-writer/deployment-template.yaml).

### Replicas track partitions

The writer's replica count auto-tracks the topic's partition count. The `start_logger_writer` tool queries Kafka admin for `logger.<table>` and uses that as `replicas` when rendering the Deployment. Single source of truth: bump partitions, the next apply rolls the Deployment to the new replica count automatically.

Default `numPartitions = 1` for new topics ([create_kafka_topic](../../apps/agent-worker/src/tools/create-kafka-topic.ts)) → default `replicas = 1`. To scale a hot table: bump `LATTIK_TOPIC_NUM_PARTITIONS` and re-fire the post-merge workflow (or call `start_logger_writer` manually).

## Exactly-once via snapshot properties

The writer uses `kafka_offset_p<n>` flat keys on the Iceberg snapshot summary as a per-partition high-water-mark. Each commit:

1. Builds a HashMap `{ "kafka_offset_p0": "12345", ... }` from the highest offset seen per partition during the batch.
2. Calls `tx.fast_append().set_snapshot_properties(hwm).add_data_files(files)` — Iceberg writes both atomically to the new snapshot.
3. After the Iceberg commit lands, commits Kafka consumer offsets.

On startup, the writer walks the table's snapshot history (newest-first by `timestamp_ms`), reads each `Snapshot::summary().additional_properties`, and resolves the **max offset per partition independently across snapshots**. This handles single-replica writers (where each commit carries every partition) and the future multi-replica case (where each replica commits only its assigned partitions). Partitions without a stored HWM fall back to `auto.offset.reset=earliest`.

If the writer crashes between Iceberg commit and Kafka offset commit, the next startup reads the snapshot HWM, seeks consumers past it, and skips the messages already written. Net result: at most one in-flight batch may be reprocessed (typically a few seconds of events) — no duplicates land in Iceberg.

References: [iceberg-rust `FastAppendAction::set_snapshot_properties`](https://github.com/apache/iceberg-rust/blob/v0.9.0/crates/iceberg/src/transaction/append.rs), [`Snapshot::summary().additional_properties`](https://github.com/apache/iceberg-rust/blob/v0.9.0/crates/iceberg/src/spec/snapshot.rs).

## Batching

- Flush whenever **5 seconds elapsed OR 10,000 rows accumulated**, whichever first.
- Skip flush entirely when buffer is empty — no empty Iceberg snapshots / metadata churn on idle tables.
- Order on flush: Iceberg commit FIRST, Kafka offset commit SECOND. The snapshot property is the load-bearing checkpoint; the consumer offset is just a hint to avoid replay.

Both bounds are env-overridable: `FLUSH_INTERVAL_SECONDS`, `FLUSH_ROWS`.

## Schema flow

The envelope schema (`lattik.logger.v1.Envelope { table, event_id, event_timestamp, payload bytes }`) is **static**, compiled into the writer image at build time via prost-build.

The per-table **payload schema** is registered in Confluent Schema Registry under subject `logger.<table>-value` by the [`register_protobuf_schema`](../../apps/agent-worker/src/tools/register-protobuf-schema.ts) tool during the post-merge workflow. The writer fetches it once at startup and uses it to decode each envelope's `payload` bytes into typed fields.

Storage layout:
- Iceberg implicit columns: `event_id` varchar, `event_timestamp` timestamp(6), `ds` varchar, `hour` varchar.
- User-defined columns from the Logger Table spec, mapped from the proto types.
- Partitioned by `(ds, hour)` — `ds`/`hour` are derived from `event_timestamp` at write time.

## Current implementation status

**Done:**
- Catalog wiring (REST + opendal-S3 to MinIO).
- Table load on startup.
- HWM resolution from snapshot history.
- Consumer subscribe + seek past HWM.
- Envelope decode loop with batched buffer and time/size-bounded flush trigger.
- Per-table Deployment template + apply tool with auto-replica-count.

**Pending (Phase 2):**
- Payload decode via SR + prost-reflect (envelope.payload bytes → typed columns).
- Arrow RecordBatch construction matching the Iceberg table schema.
- Parquet write via iceberg-rust's writer chain.
- `fast_append().set_snapshot_properties(hwm)` + commit + Kafka offset commit.

The current image will boot, connect, log "subscribed + HWM resolved", and accumulate envelopes in memory but won't append data to Iceberg yet. Apply correctness, deployment lifecycle, and partition→replica auto-scaling can already be validated end-to-end.

## Operations

- **View pods:** `kubectl get deploy -n workloads -l app=logger-writer`
- **Tail logs for one table:** `kubectl logs -n workloads -l lattik.io/logger-table=ingest.clicks -f`
- **Force a restart (e.g. after schema change):** the post-merge workflow's `start_logger_writer` re-applies the manifest, which triggers a rolling restart automatically. Manual: `kubectl rollout restart -n workloads deployment/logger-writer-<safe-name>`.
- **Stop a writer:** `kubectl delete deploy/logger-writer-<safe-name> -n workloads`. Future plan: tie this to a `delete_logger_writer` tool when Logger Table deletion lands as a webhook event.
