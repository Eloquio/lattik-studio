# End-to-End Test Plan

This document describes the full manual acceptance test for Lattik Studio: define Logger Tables → generate an SDK → publish events → ingest into Iceberg → define a Lattik Table → materialize via Airflow+Spark → read from Spark and Trino. Running this plan once end-to-end exercises every moving part of the platform on a single kind cluster.

## Scenario

Domain: an e-commerce site tracking user behavior. The test defines three Logger Tables (one per event stream) and one Lattik Table keyed by `user_id` with three column families — one per source — so that every aggregation strategy (`lifetime_window`, `prepend_list`, `bitmap_activity`) is exercised at least once.

| Artifact | Name | Role |
|---|---|---|
| Logger Table | `ingest.page_views` | Raw page view stream, high volume, mostly primitive columns |
| Logger Table | `ingest.click_events` | Raw click stream, tests JSON payloads |
| Logger Table | `ingest.purchases` | Raw purchase stream, low volume, tests sparse joins |
| Lattik Table | `analytics.user_behavior` | User-grain summary stitched from all three sources |

## Prerequisites & known gaps

Before running the plan, confirm these are in place. Each is a known source of confusion if assumed.

- **Stitcher status.** [`lattik-table-stitch.md`](infra/lattik-table-stitch.md) is marked draft. If the read-side resolver in [`lattik-stitch/`](../lattik-stitch/) is stubbed or partially implemented, phases 6 and 7 cannot succeed as written — the queries will either hit a missing catalog or get a schema mismatch. Check before starting.
- **Kafka → Iceberg ingestion pipeline.** Raw events land in Iceberg via a Spark batch job that drains each per-table Kafka topic. If that job is not yet implemented, phase 3 will stall. Substitute a one-off Spark job or stop at phase 2.
- **Host prerequisites.** Docker, kubectl, kind, helm, pnpm, portless. Memory: at least 16 GB recommended; the full stack runs postgres, gitea, minio, iceberg-rest, trino, kafka, schema-registry, ingest, spark-operator, and airflow simultaneously.

## Phase 0 · Bring up the stack

From a fresh clone (or a teardown):

```bash
cd projects/lattik-studio
pnpm install
pnpm dev:up
```

`pnpm dev:up` handles cluster creation, all custom image builds, database schema push and seed, and every service start in dependency order. It ends with a printed checklist of remaining manual steps.

Complete the manual steps from the checklist:

1. Fill in `AI_GATEWAY_API_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` in [`apps/web/.env`](../apps/web/.env.example).
2. In a separate terminal: `portless proxy start --tld dev`
3. In a separate terminal: `pnpm dev`
4. Open `https://lattik-studio.dev` and sign in with Google.

### Pre-flight checks before proceeding

- [ ] `kubectl get pods -A` — every pod Running (postgres, gitea, minio, iceberg-rest, trino, kafka, schema-registry, ingest, spark-operator, airflow-{api-server,scheduler,dag-processor})
- [ ] `curl http://localhost:8181/v1/config` — Iceberg REST catalog returns 200
- [ ] `curl http://localhost:8090/healthz` — ingest service returns 200
- [ ] MinIO console at `http://localhost:9001` — `warehouse` bucket exists
- [ ] Airflow UI at `http://localhost:8088` — no DAG import errors in the scheduler logs
- [ ] `https://lattik-studio.dev` loads with the signed-in user

## Phase 1 · Define three Logger Tables

**Goal:** exercise the Data Architect agent flow (`renderLoggerTableForm` → `staticCheck` → `updateDefinition` → `generateYaml` → `submitPR`), three times, via chat. See [`apps/web/src/extensions/data-architect/skills/defining-logger-table.md`](../apps/web/src/extensions/data-architect/skills/defining-logger-table.md).

Do not hand-author YAML. The point of this phase is to validate the agent → canvas → PR pipeline end-to-end.

### Table 1 — `ingest.page_views`

High volume, primitive columns. Retention `30d`, dedup window `1h`.

| Column | Type | Notes |
|---|---|---|
| `user_id` | string | dimension: user |
| `url` | string | |
| `referrer` | string | nullable |
| `session_id` | string | |
| `viewport_width` | int32 | |
| `load_time_ms` | int32 | |

### Table 2 — `ingest.click_events`

Tests JSON payload columns. Retention `30d`, dedup window `1h`.

| Column | Type | Notes |
|---|---|---|
| `user_id` | string | dimension: user |
| `element_id` | string | |
| `page_url` | string | |
| `position` | json | `{x, y}` |
| `is_bot` | boolean | |

### Table 3 — `ingest.purchases`

Sparse, tests float and string columns. Retention `365d`, dedup window `24h`.

| Column | Type | Notes |
|---|---|---|
| `user_id` | string | dimension: user |
| `order_id` | string | |
| `product_id` | string | |
| `amount` | double | |
| `currency` | string | |
| `country` | string | |

### Acceptance (per table)

- [ ] Canvas form renders after the agent calls `renderLoggerTableForm`
- [ ] `staticCheck` passes — no duplicate columns, no reserved implicit column names (`event_id`, `event_timestamp`, `ds`, `hour`), all column types valid
- [ ] `generateYaml` produces a readable, editable spec
- [ ] `submitPR` creates a Gitea PR; merging it fires the webhook at [`apps/web/src/app/api/webhooks/gitea/route.ts`](../apps/web/src/app/api/webhooks/gitea/route.ts)
- [ ] Post-merge: definition persisted in Postgres, Kafka topic `logger.ingest.<table>` auto-created on first produce, Schema Registry has the Protobuf subject registered

## Phase 2 · Generate SDKs and publish random events

**Goal:** exercise the codegen → client → HTTP → Kafka → dedup path end-to-end.

### Step 2a — regenerate the SDK

After merging the three PRs, run `buf` codegen to produce TypeScript classes for each table's payload proto. The generator is driven by [`packages/lattik-logger/buf.gen.yaml`](../packages/lattik-logger/buf.gen.yaml) and [`packages/lattik-logger/src/codegen/proto-gen.ts`](../packages/lattik-logger/src/codegen/proto-gen.ts).

Confirm three generated `*_pb.ts` files exist and each re-exports a `*Schema`.

### Step 2b — write a seeding script

Create a disposable script at `scripts/seed-events.ts` (do not commit; this is a test fixture). It should:

- Create 100 synthetic users (`user_000` through `user_099`)
- For each user, produce a realistic trail across the last 7 `ds` partitions:
  - ~20 `page_views` per user per day
  - ~5 `click_events` per user per day (set `is_bot=true` on ~5% to test nullability and filter semantics downstream)
  - ~0.5 `purchases` per user per day (most days zero — sparse join coverage)
- Use one `LoggerClient` per table, each with `HttpTransport({ url: "http://localhost:8090/v1/events" })`
- Pin `event_timestamp` to discrete hours so partition pruning can be tested later
- Log expected totals so assertions in later phases have ground-truth numbers

### Test variants

Run the following variants explicitly — each catches a different class of bug.

1. **Happy path.** 100 users × 7 days. Assert that the ingest service returns 2xx for every call.
2. **Deduplication.** Replay the same batch twice with identical `event_id`s within 1h. Exactly one row should end up in Iceberg per unique id. Tests the TTL cache in [`apps/ingest/main.go`](../apps/ingest/main.go).
3. **Schema forward-compat (negative test).** Hand-serialize an envelope with a field number that does not exist in the current schema. Ingest should accept (Protobuf is forward-compatible); the downstream Spark job should either drop or surface unknown fields per the chosen contract. Document the observed behavior — this is precisely the kind of spec ambiguity an E2E test is meant to pin down.
4. **Wrong table name (negative test).** POST to `ingest.does_not_exist`. Expect either rejection or topic auto-create, depending on policy. Document which.

### Acceptance

- [ ] `kubectl -n kafka exec deploy/kafka -- /opt/kafka/bin/kafka-console-consumer.sh --topic logger.ingest.page_views --bootstrap-server localhost:9092 --from-beginning --timeout-ms 5000 | wc -l` is approximately the expected count after dedup
- [ ] Each of the three topics has a matching subject in Schema Registry (`curl http://localhost:8081/subjects`)
- [ ] Ingest service logs show zero 5xx responses

## Phase 3 · Verify Iceberg ingestion

**Goal:** confirm raw events land in Iceberg before any Lattik Table logic enters the picture. Isolates any bug to the ingest path.

1. Trigger (or wait for) the Spark batch job that drains Kafka into Iceberg for each logger table. Observe via `kubectl get sparkapplications -n workloads` and tail the driver logs.
2. Query the REST catalog:
   ```bash
   curl http://localhost:8181/v1/namespaces/ingest/tables
   ```
   Expect all three tables present.
3. From Trino (`pnpm trino:cli`):
   ```sql
   SELECT ds, hour, COUNT(*) FROM iceberg.ingest.page_views GROUP BY 1, 2 ORDER BY 1, 2;
   SELECT COUNT(DISTINCT user_id) FROM iceberg.ingest.click_events;
   SELECT SUM(amount) FROM iceberg.ingest.purchases;
   ```
4. Cross-check counts against the seed script's expected totals.
5. Verify MinIO layout: `s3://warehouse/iceberg/ingest/{page_views,click_events,purchases}/{metadata,data}/` all populated.

### Acceptance

- [ ] Row counts match expected totals within the dedup tolerance
- [ ] `ds` and `hour` partitioning visible in Trino's `$partitions` metadata table
- [ ] Implicit columns (`event_id`, `event_timestamp`, `ds`, `hour`) present on every row

## Phase 4 · Define the Lattik Table with three column families

**Goal:** exercise all three aggregation strategies (`lifetime_window`, `prepend_list`, `bitmap_activity`) in one definition. DSL at [`apps/web/src/extensions/data-architect/schema.ts`](../apps/web/src/extensions/data-architect/schema.ts). Workflow at [`apps/web/src/extensions/data-architect/skills/defining-lattik-table.md`](../apps/web/src/extensions/data-architect/skills/defining-lattik-table.md).

**Table:** `analytics.user_behavior`
**Primary key:** `[{ column: "user_id", entity: "user" }]` — no time component; uses Iceberg as-of semantics for history.

### Column family A — `browsing` (source: `ingest.page_views`)

Tests `lifetime_window`.

- `key_mapping: { user_id: user_id }`
- `load_cadence: daily`
- Columns:
  - `page_view_count` — `lifetime_window: { agg: "count()" }`
  - `total_load_time_ms` — `lifetime_window: { agg: "sum(load_time_ms)" }`
  - `avg_viewport_width` — `lifetime_window: { agg: "avg(viewport_width)" }`
  - `last_url_seen` — `lifetime_window: { agg: "last(url)" }`

### Column family B — `engagement` (source: `ingest.click_events`)

Tests `prepend_list` and `bitmap_activity`.

- `key_mapping: { user_id: user_id }`
- `load_cadence: hourly`
- Columns:
  - `recent_element_ids` — `prepend_list: { expr: "element_id", max_length: 50 }`
  - `daily_activity` — `bitmap_activity: { granularity: "day", window: 30 }`

### Column family C — `commerce` (source: `ingest.purchases`)

Tests `lifetime_window` over sparse data and `prepend_list` over strings.

- `key_mapping: { user_id: user_id }`
- `load_cadence: daily`
- Columns:
  - `total_spend` — `lifetime_window: { agg: "sum(amount)" }`
  - `purchase_count` — `lifetime_window: { agg: "count()" }`
  - `countries_purchased_from` — `prepend_list: { expr: "country", max_length: 10 }`

### Derived columns (optional)

- `avg_order_value` — `expr: "total_spend / purchase_count"` — exercises divide-by-zero semantics for users with no purchases.

### Acceptance

- [ ] Agent renders `renderLattikTableForm` with all three families visible
- [ ] `staticCheck` validates — especially that each `key_mapping` targets an existing column in the source table
- [ ] YAML generated, PR created, PR merged
- [ ] On merge, the Gitea webhook invokes `generateDags()` and a YAML DAG spec appears at `s3://warehouse/airflow-dags/`
- [ ] Airflow `dag-processor` imports the DAG without error (check `kubectl logs -n airflow deploy/airflow-dag-processor`)

## Phase 5 · Materialization (Airflow + Spark)

**Goal:** the DAG runs end-to-end, Spark jobs produce load folders, the commit endpoint atomically records the manifest.

1. Airflow UI at `http://localhost:8088` — find the `analytics.user_behavior` DAG, unpause, trigger a run for the most recent `ds`.
2. Task 1 (`wait`, `DataReadySensor`) polls `GET /v1/namespaces/ingest/tables/page_views` and the other source tables; should succeed immediately since phase 3 already landed the data.
3. Task 2 (`spark`) launches a `SparkApplication` in the `workloads` namespace. Observe with `kubectl get sparkapplications -n workloads -w`.
4. Driver logs should show: read each source Iceberg table → apply each family's strategy → write load folders to `s3://warehouse/lattik/analytics/user_behavior/<family>/<load_id>/` → `POST` to [`/api/lattik/commit`](../apps/web/src/app/api/lattik/commit/route.ts).
5. Inspect Postgres `lattik_table_commits` (or the equivalent table) — one row per family load, all tied to a single commit id.

### Negative tests to run once

- **Source not ready.** Delete `ingest.click_events` from the Iceberg catalog and re-trigger the DAG. The `wait` task should hang at the sensor rather than crash. Restore the table afterward.
- **Commit API unreachable.** Scale the web app to zero mid-run. Spark should fail cleanly; Airflow marks the task failed; a retry after scaling back up should succeed. Validates the ownership boundary between Spark and the metadata service.
- **Partial failure atomicity.** Kill one column family's Spark task mid-run. Confirm the commit is atomic — no partial rows visible on read.

### Acceptance

- [ ] DAG run is green
- [ ] Three load folders exist in MinIO under `s3://warehouse/lattik/analytics/user_behavior/`
- [ ] A single commit row in Postgres ties all three loads together
- [ ] No orphaned load folders after a failed run + retry

## Phase 6 · Read from Spark

**Goal:** Spark can read the materialized Lattik Table and see all three families stitched into a unified view.

Submit a `SparkApplication` modeled on [`k8s/spark-example.yaml`](../k8s/spark-example.yaml), pointed at the Iceberg REST catalog, and run the following queries.

```sql
-- Basic scan
SELECT user_id, page_view_count, total_spend, recent_element_ids
FROM lattik.analytics.user_behavior
LIMIT 10;

-- Cross-family aggregation (tests stitcher correctness)
SELECT
  COUNT(*)                                  AS user_count,
  AVG(page_view_count)                      AS avg_views,
  SUM(total_spend)                          AS total_revenue,
  AVG(cardinality(recent_element_ids))      AS avg_recent_clicks
FROM lattik.analytics.user_behavior;

-- Point lookup (tests IndexedStitcher path if enabled)
SELECT * FROM lattik.analytics.user_behavior WHERE user_id = 'user_042';

-- Derived column
SELECT user_id, avg_order_value
FROM lattik.analytics.user_behavior
WHERE purchase_count > 0
ORDER BY avg_order_value DESC
LIMIT 5;
```

### Acceptance (assertions against seed-script ground truth)

- [ ] Row count equals 100 (one per seeded user)
- [ ] `SUM(page_view_count)` equals the total seeded `page_view` events after dedup
- [ ] `SUM(total_spend)` equals the sum of seeded purchase amounts
- [ ] `cardinality(recent_element_ids) <= 50` for every row
- [ ] `daily_activity` bitmap length equals 30 for every row
- [ ] Users with no purchases have `purchase_count = 0` and `avg_order_value` NULL (not a divide-by-zero error)

## Phase 7 · Read from Trino

**Goal:** same table, different engine, same answers. This is the cross-engine invariant test and the single most valuable check in the plan. If Spark and Trino disagree by a single row, there is either a stitcher bug, a non-deterministic aggregation, or a catalog visibility issue — all three are silent failures that earlier phases will miss.

```bash
pnpm trino:cli
```

Run every query from phase 6, plus:

```sql
-- Predicate pushdown
SELECT user_id, total_spend
FROM iceberg.analytics.user_behavior
WHERE total_spend > 100;

-- Metadata inspection
SELECT * FROM iceberg.analytics."user_behavior$snapshots";
SELECT * FROM iceberg.analytics."user_behavior$files" LIMIT 5;

-- Time travel (if the stitcher supports as-of)
SELECT COUNT(*)
FROM iceberg.analytics.user_behavior
FOR TIMESTAMP AS OF TIMESTAMP '<earlier commit ts>';
```

### Acceptance

- [ ] Every scalar aggregate from phase 6 matches Trino's output exactly
- [ ] Trino can inspect the Iceberg metadata tables (`$snapshots`, `$files`)
- [ ] Full-scan query latency is reasonable on a 100-user dataset (under 5 seconds)

## Phase 8 · Teardown and rerun

Verify determinism and clean teardown.

- [ ] `pnpm dev:down` destroys the kind cluster cleanly
- [ ] `pnpm dev:up` followed by re-running the full plan produces identical phase 7 numbers. Any flakiness here points to non-determinism (unordered `last()`, dedup TTL interactions, partition clock skew, or load-order-dependent stitching).

## What this plan intentionally does not cover

- **Production deployment.** Everything here runs against the local kind cluster.
- **High concurrency or scale.** The seed script's 100 users and 7 days are enough to validate correctness, not enough to stress-test the stitcher or the Spark scheduler.
- **Auth boundary testing.** The plan assumes the user is signed in via Google OAuth and the `LATTIK_API_TOKEN` bearer is set correctly; it does not probe authz edges.
- **Schema evolution across merges.** Adding a column to an already-materialized Logger or Lattik Table is out of scope — test it separately when the schema-evolution feature lands.
- **Backfill correctness.** The plan materializes the most recent partition only; full historical backfill is a separate test.
