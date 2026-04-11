# Lattik Table Stitch: Design

> **Status:** Draft. Describes how multiple Column Families are stitched into a single queryable Lattik Table.

## Problem

A Lattik Table has N column families, each pulling from a different source table (Logger or Lattik), all sharing the same primary key (entity grain). Today the schema, validation, and DAG orchestration exist, but the **physical stitch** — combining N independent source streams into one unified Iceberg table — is not implemented.

From the query engine's perspective, `SELECT * FROM lattik.user_stats` should return a single table with the union of all family columns plus derived columns. The engine should have no awareness that stitching is happening.

## Goals

1. **Transparent reads.** Spark and Trino see one Iceberg table. No special query syntax.
2. **Correct merge semantics.** Incremental loads apply per-column strategies: Prepend List, Lifetime Window, or Bitmap Activity.
3. **Column pruning.** If a query only touches columns from one family, the other families are never read.
4. **Predicate pushdown.** PK filters push down into every family's source scan.
5. **Shuffle-free reads.** Write-time hierarchical bucketing by PK ensures read-time stitching requires no shuffle. The `NaiveStitcher` hash-joins in memory; the `IndexedStitcher` uses PK index probes + random access with zero-copy output.

## Architecture overview

```
                        ┌─────────────────────────────┐
                        │       Query Engine           │
                        │   (Spark SQL / Trino)        │
                        └──────────┬──────────────────┘
                                   │
                          SELECT ... FROM lattik.user_stats
                                   │
                        ┌──────────▼──────────────────┐
                        │  LattikCatalog (Spark) /     │
                        │  LattikConnector (Trino)     │
                        │                              │
                        │  Resolves manifest version   │
                        │  from Postgres commit log,   │
                        │  fetches manifest from S3.   │
                        └──────────┬──────────────────┘
                                   │
                        ┌──────────▼──────────────────┐
                        │  Rust Core (lattik-stitch)   │
                        │  via JNI                     │
                        │                              │
                        │  Resolves columns → loads    │
                        │  Opens FamilyFormat readers  │
                        │  Runs Stitcher               │
                        │  Returns Arrow RecordBatches │
                        │  via C Data Interface        │
                        └──────┬───────────────────────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
         ┌──────▼──────┐ ┌────▼──────┐ ┌─────▼─────┐
         │ load:       │ │ load:     │ │ load:     │
         │ uuid-aaa    │ │ uuid-bbb  │ │ uuid-ccc  │
         │ (Vortex,    │ │ (Parquet, │ │ (Vortex,  │
         │  indexed)   │ │  sorted)  │ │  indexed) │
         └─────────────┘ └───────────┘ └───────────┘
              (immutable load folders on S3,
               hierarchically bucketed by PK,
               format + bucket_count per load,
               auto-determined from data volume.)
```

**Key insight:** Since we generate the Spark batch jobs that write data, we control the physical layout. Each family's pre-aggregated output is written as **columnar files on S3**, bucketed by PK with a sidecar PK index per bucket. No hidden Iceberg tables — just data files at known S3 paths.

- **Unsorted data, indexed reads.** Data files are written in arrival order (no sorting overhead). A sidecar `pk_index` file per bucket maps PK → row_id, sorted by PK. For full scans the `NaiveStitcher` reads data sequentially and hash-joins in memory. For point lookups the `IndexedStitcher` probes the sorted PK index (zone-map pruning gives near-binary-search efficiency) then random-accesses the data file.
- **Per-load auto-bucketing.** Each load independently auto-sizes its hierarchical bucket levels (each a power of 2) based on data volume, targeting ~128MB per bucket. Different loads can have different counts — power-of-2 alignment at each level (see [Bucketing contract](#bucketing-contract)).
- **Pluggable file format.** Parquet, Lance, or Vortex. Vortex is recommended for its 100x faster random access (enables the `IndexedStitcher`) and compute-on-compressed-data (filter evaluation without decompression).
- **Three column strategies.** Each column declares how source events are aggregated and stored: `lifetime_window` (scalar aggregation), `prepend_list` (bounded recent-values list), or `bitmap_activity` (activity bitfield).

## Physical storage layout

The physical storage is organized around **loads**, **manifests**, and **snapshots**. There are no Iceberg tables for column data — just immutable files on S3, with the active manifest pointer stored in Postgres for atomic commits.

- A **load** is a single batch job execution that writes data for one or more columns. Each load gets a UUID and writes its files to a unique folder. Load folders are immutable — once written, never modified. Each load is self-describing via `load.json`.
- A **manifest** is a versioned JSON file containing a single column→load_id mapping. Manifests are immutable — each batch job writes a new version. The filename includes the load ID to avoid S3 collisions between concurrent writers.
- The **commit log** (`lattik_table_commits` in Postgres) is the append-only history of committed manifest versions. Time travel resolves via Postgres queries. A second table (`lattik_column_loads`) tracks per-column ETL time for `AS OF DS` queries.

### S3 directory structure

```
s3://warehouse/lattik/<table_name>/
  manifests/
    v0001_a1b2c3d4.json                    ← immutable manifest versions (v<N>_<load_id>.json)
    v0002_e5f6g7h8.json
    v0003_i9j0k1l2.json
  loads/
    <uuid-a>/                              ← load 1 (Vortex: unsorted + PK index)
      load.json                            ← load metadata
      bucket=0000/
        data.vortex                        ← PK + columns (unsorted)
        pk_index.vortex                    ← (pk, row_id) sorted by pk
      ...
    <uuid-b>/                              ← load 2 (Parquet: sorted, no sidecar)
      load.json
      bucket=0000/
        data.parquet                       ← PK + columns (sorted by PK)
      ...
```

The physical layout of each bucket depends on the load's format and capabilities (recorded in `load.json`):

| Format | Bucket contents | Data order | Read strategy |
|---|---|---|---|
| **Vortex** | `data.vortex` + `pk_index.vortex` | Unsorted (fast writes) | PK index for point lookups; sequential scan for full reads |
| **Parquet** | `data.parquet` (no sidecar) | Sorted by PK (enables merge joins) | Sequential scan with sorted-data guarantees |
| **Lance** | `data.lance` + `pk_index.lance` | Unsorted | Same as Vortex |

Each load folder contains:
- **`load.json`** — self-describing metadata for this load
- **`bucket=NNNN/data.<ext>`** — PK columns + the columns produced by this load
- **`bucket=NNNN/pk_index.<ext>`** — (optional) sidecar index mapping `(pk → row_id)`, **sorted by PK**. Present when the format supports fast random access (Vortex, Lance). Absent for Parquet (where data is sorted instead).

**`load.json`:**

```json
{
  "load_id": "e5f6g7h8",
  "timestamp": "2026-04-09T14:00:00Z",
  "ds": "2026-04-09",
  "hour": null,
  "mode": "forward",
  "format": "vortex",
  "bucket_levels": [32, 4],
  "bucket_count": 128,
  "sorted": false,
  "has_pk_index": true,
  "columns": ["lifetime_revenue", "purchase_count", "daily_purchase_activity"]
}
```

- `timestamp` — wall clock time when the load was written
- `ds` / `hour` — the Airflow logical execution date. A backfill triggered on April 10th for `ds=2026-04-01` has `ds: "2026-04-01"` and `timestamp: "2026-04-10T..."`.
- `mode` — `"forward"` (normal cadence run) or `"backfill"` (backfill or cascade recompute). Informational — the data format is identical in both modes (delta + cumulative).

Parquet example:

```json
{
  "load_id": "j3k4l5m6",
  "timestamp": "2026-04-09T00:00:00Z",
  "ds": "2026-04-09",
  "hour": null,
  "mode": "forward",
  "format": "parquet",
  "bucket_levels": [64],
  "bucket_count": 64,
  "sorted": true,
  "has_pk_index": false,
  "columns": ["home_country"]
}
```

Each load is fully self-describing — you can inspect a load folder in isolation without needing the manifest. The `sorted` and `has_pk_index` flags tell the reader what capabilities this load offers, so it can pick the right stitcher strategy.

Concrete example for `user_stats`:

```
s3://warehouse/lattik/user_stats/
  manifests/
    v0001_a1b2c3d4.json                    ← initial manifest (after first load)
    v0002_i9j0k1l2.json                    ← after 06:00 incremental
  loads/
    a1b2c3d4/                              ← signups family, initial load (Parquet, sorted)
      load.json                            ← format: parquet, sorted: true, has_pk_index: false
      bucket=0000/
        data.parquet                       ← user_id, home_country (sorted by user_id)
      bucket=0001/
        data.parquet
      ...  (32 buckets)
    e5f6g7h8/                              ← purchases family, initial load (Vortex, indexed)
      load.json                            ← format: vortex, sorted: false, has_pk_index: true
      bucket=0000/
        data.vortex                        ← user_id, lifetime_revenue, purchase_count, daily_activity
        pk_index.vortex
      ...  (128 buckets)
    i9j0k1l2/                              ← signups family, 06:00 incremental (Vortex, indexed)
      load.json                            ← format: vortex, sorted: false, has_pk_index: true
      bucket=0005/
        data.vortex
        pk_index.vortex
      bucket=0019/
        data.vortex
        pk_index.vortex
```

Postgres (`lattik_table_commits`): `user_stats` has commits v1 (a1b2c3d4) and v2 (i9j0k1l2)

### Table manifest (versioned, immutable on S3)

Each manifest version is an immutable JSON file at `manifests/v<N>_<load_id>.json`. The filename includes the load ID that created it, so concurrent writers never collide on the same S3 key. Each manifest contains a **single snapshot** — the column→load_id mapping at that version. The timeline (history of snapshots) lives in Postgres, not in the manifest.

```json
{
  "version": 3,
  "columns": {
    "home_country":             "i9j0k1l2",
    "lifetime_revenue":         "e5f6g7h8",
    "purchase_count":           "e5f6g7h8",
    "daily_purchase_activity":  "e5f6g7h8"
  }
}
```

The manifest is intentionally minimal — just `version` + column→load_id strings. No snapshots list, no timeline, no config. Physical details (format, bucket_count, column list) are resolved by fetching the load's `load.json`. This means:
- **No duplication.** `bucket_count` and `format` are stated once in `load.json`, not repeated per column.
- **Different loads can use different formats.** An older load wrote Parquet, a newer load writes Vortex. The reader fetches each load's `load.json` and uses the correct `FamilyFormat`.
- **Load folders are self-describing.** Useful for debugging, auditing, and GC — a load can be inspected in isolation.

### Postgres tables

Two tables track the table's history at different granularities:

**`lattik_table_commits`** — table-level manifest history (append-only log):

```sql
CREATE TABLE lattik_table_commits (
  table_name        TEXT NOT NULL,
  manifest_version  INT NOT NULL,
  manifest_load_id  TEXT NOT NULL,          -- → manifests/v<N>_<load_id>.json
  committed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, manifest_version)
);

CREATE INDEX idx_commits_wall_time
  ON lattik_table_commits (table_name, committed_at DESC);
```

Used for: latest state, wall-clock time travel, rollback, audit trail.

**`lattik_column_loads`** — per-column ETL time tracking:

```sql
CREATE TABLE lattik_column_loads (
  table_name        TEXT NOT NULL,
  column_name       TEXT NOT NULL,
  ds                DATE NOT NULL,
  hour              INT,                    -- NULL for daily cadence
  load_id           TEXT NOT NULL,
  manifest_version  INT NOT NULL,           -- which commit includes this load
  committed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, column_name, ds, hour)
);

CREATE INDEX idx_column_loads_ds
  ON lattik_column_loads (table_name, ds, hour);
```

Used for: ETL time travel (`AS OF DS`). Each row says "column X for ds=Y was produced by load Z." Backfills use `ON CONFLICT DO UPDATE` — re-running `ds=2026-04-01` overwrites the previous entry for that column+ds, making ETL idempotent.

**Why two tables?** The table operates at two time axes:
- **Wall clock** — when commits happened. Tracked per table (one manifest per commit).
- **ETL time (`ds`)** — which logical date each column's data represents. Tracked per column (different columns can have different ds values, load at different cadences, and be backfilled independently).

Each batch job writes to both: INSERT into `lattik_table_commits` for the manifest, and UPSERT into `lattik_column_loads` for each column's ds.

### Commit flow (OCC)

```
1. Read latest commit from Postgres:
     SELECT manifest_version, manifest_load_id
     FROM lattik_table_commits
     WHERE table_name = 'user_stats'
     ORDER BY manifest_version DESC LIMIT 1
   → base_version=15, base_load_id=abc123

2. Write load files to S3:
     loads/<our-uuid>/load.json + bucket files

3. Build new manifest based on v15:
     Fetch manifests/v0015_abc123.json
     Copy its column map, override columns from our new loads
     Write manifests/v0016_<our-uuid>.json (immutable)
   (filename includes our load UUID — no S3 collision with concurrent writers)

4. Atomic commit — INSERT into Postgres:
     INSERT INTO lattik_table_commits (table_name, manifest_version, manifest_load_id)
     VALUES ('user_stats', 16, '<our-uuid>')
   → Success (PK constraint)? Done.
   → Conflict (version 16 already exists)? Another writer committed first. Retry:
     a. Read new latest from Postgres       → version=16, load_id=other-uuid
     b. Fetch manifests/v0016_<other-uuid>.json from S3
     c. Rebase: apply our column overrides on top of v16's column map
        (load files are already on S3 — no re-aggregation, no rewrite)
     d. Write manifests/v0017_<our-uuid>.json
     e. INSERT with version=17
     f. Repeat until success
```

**Why include the load ID in the manifest filename?** Two concurrent writers both based on v15 will both try to write a v16 manifest. With `v0016.json` as the filename, one would overwrite the other on S3 — a silent data loss. With `v0016_<uuid>.json`, both manifests coexist safely on S3. The Postgres INSERT's PK constraint determines which one wins; the loser's manifest becomes an orphan (cleaned by GC).

The retry is cheap — only a JSON file write + a Postgres INSERT. The load data on S3 is already written and correct. The rebase simply applies the column overrides to the winner's column map.

**Crash safety:**
- Crash at step 2 → orphaned load files on S3. Postgres unchanged. Readers unaffected. GC cleans up.
- Crash at step 3 → orphaned manifest on S3. Postgres unchanged. Readers unaffected.
- Crash at step 4 → manifest written but not committed. Readers still on old version. Next run retries.

### Reader resolution flow

**Latest state (default):**

```
1. Query Postgres:
     SELECT manifest_version, manifest_load_id
     FROM lattik_table_commits
     WHERE table_name = 'user_stats'
     ORDER BY manifest_version DESC LIMIT 1
   → version=3, load_id=i9j0k1l2

2. Fetch s3://.../manifests/v0003_i9j0k1l2.json  → column → load_id map
3. Resolve requested columns to load IDs          → {home_country → i9j0k1l2, ...}
4. Group columns by load_id                       → {i9j0k1l2: [home_country], e5f6g7h8: [...]}
5. Fetch load.json for each unique load           → get format, bucket_count (cached aggressively)
6. Plan partitions, read bucket files, stitch
```

Key properties:
- **Column-level tracking.** Each column independently maps to a load ID. Columns can migrate between families over time. The manifest doesn't care about families — it tracks columns to loads.
- **Columns sharing a load ID are in the same data files.** The reader groups columns by load ID to avoid redundant file opens and redundant `load.json` fetches.
- **Manifest is minimal.** Just `version` + `column → load_id` strings. One snapshot per manifest, no timeline.
- **Timeline lives in Postgres.** The `lattik_table_commits` table is the append-only history. Time travel is a SQL query.
- **Loads are self-describing.** `load.json` carries format, bucket_count, column list. A load folder can be inspected, debugged, or audited in isolation.
- **Per-load format and bucket_count.** Each load independently chooses its format and bucket count. Power-of-2 bucket alignment still applies across loads.
- **Manifests are immutable.** Each batch job writes a new version. Old versions are retained for rollback and debugging.
- **Atomic commit via Postgres INSERT.** Append-only log. No updates, no deletes (except GC).

### Time travel

Three modes, each resolving via a single Postgres query:

**Mode 1: Latest state (default)** — no time travel

```sql
SELECT ... FROM lattik.user_stats
```

Resolution:
```
1. SELECT manifest_version, manifest_load_id
   FROM lattik_table_commits
   WHERE table_name = 'user_stats'
   ORDER BY manifest_version DESC LIMIT 1
2. Fetch manifest from S3 → column → load_id map
3. Fetch load.json per unique load → stitch
```

**Mode 2: Wall-clock time travel** — "what did the table look like at 3am?"

Useful for debugging: "what did the dashboard show this morning?" Uses each engine's native time-travel syntax.

```sql
-- Spark
SELECT ... FROM lattik.default.user_stats TIMESTAMP AS OF '2026-04-10T03:00:00Z'

-- Trino
SELECT ... FROM lattik.default.user_stats FOR TIMESTAMP AS OF TIMESTAMP '2026-04-10 03:00:00 UTC'
```

Both engines pass the timestamp to the catalog/connector. The `LattikCatalog` (Spark) / `LattikConnector` (Trino) resolves it against `lattik_table_commits`:

```
1. SELECT manifest_version, manifest_load_id
   FROM lattik_table_commits
   WHERE table_name = 'user_stats' AND committed_at <= '2026-04-10T03:00:00Z'
   ORDER BY committed_at DESC LIMIT 1
   → the latest commit before 3am
2. Fetch manifest from S3 → column → load_id map
3. Fetch load.json per unique load → stitch
```

Same path as default, just filtered by `committed_at`.

**Mode 3: ETL time travel** — "give me data for ds=2026-04-05"

Useful for analytics and idempotent results: every column comes from a load that was triggered for exactly that `ds`. Backfills are reflected immediately.

The SQL syntax differs per engine because Spark does not support custom table-valued functions on V2 catalogs, while Trino does:

```sql
-- Spark: uses SQL OPTIONS clause
SELECT home_country, lifetime_revenue
FROM lattik.default.user_stats OPTIONS (ds '2026-04-05')

-- Spark: with hour precision
SELECT home_country, lifetime_revenue
FROM lattik.default.user_stats OPTIONS (ds '2026-04-05', hour '12')

-- Trino: uses connector table function
SELECT home_country, lifetime_revenue
FROM TABLE(lattik.system.user_stats_at(ds => DATE '2026-04-05'))

-- Trino: with hour precision
SELECT home_country, lifetime_revenue
FROM TABLE(lattik.system.user_stats_at(ds => DATE '2026-04-05', hour => 12))
```

In Spark, the `OPTIONS` map is passed to `TableCatalog.loadTable()`. In Trino, the `ConnectorTableFunction` receives typed scalar parameters. Both route to the same Rust core resolution logic.

Resolution — **bypasses the manifest entirely**, resolves per-column from `lattik_column_loads`:
```
1. SELECT column_name, load_id
   FROM lattik_column_loads
   WHERE table_name = 'user_stats'
     AND column_name IN ('home_country', 'lifetime_revenue')
     AND ds = '2026-04-05'
     AND (hour IS NULL OR hour = (
       SELECT MAX(hour) FROM lattik_column_loads
       WHERE table_name = 'user_stats' AND column_name = c.column_name AND ds = '2026-04-05'
     ))
   → per column: latest hour for that ds (or NULL for daily cadence)
   → {home_country: uuid-aaa, lifetime_revenue: uuid-bbb}

2. Fetch load.json for each unique load → get format, bucket_count
3. Plan partitions, read bucket files, stitch
```

When `hour` is explicitly provided (e.g., `hour '12'`), the query filters to exactly that hour. When omitted, it resolves to the latest available hour for that ds per column — giving you "the most complete state for that day."

If a requested column has no entry for that `ds` (the family hasn't loaded it yet), the engine returns an error:
```
Column 'lifetime_revenue' has no load for ds=2026-04-05.
Available: home_country (loaded), lifetime_revenue (missing).
```

**Summary:**

| Mode | Spark syntax | Trino syntax | Resolves via |
|---|---|---|---|
| Latest | `SELECT ... FROM lattik.default.user_stats` | `SELECT ... FROM lattik.default.user_stats` | Latest manifest via `lattik_table_commits` |
| Wall-clock | `... TIMESTAMP AS OF '...'` | `... FOR TIMESTAMP AS OF TIMESTAMP '...'` | `committed_at` in `lattik_table_commits` |
| ETL (ds) | `... OPTIONS (ds '2026-04-05')` | `TABLE(lattik.system.user_stats_at(ds => ...))` | Per-column in `lattik_column_loads` |
| ETL (ds+hour) | `... OPTIONS (ds '2026-04-05', hour '12')` | `TABLE(lattik.system.user_stats_at(ds => ..., hour => 12))` | Per-column in `lattik_column_loads` |

Each mode is a single Postgres query + S3 fetches for the load files. No scanning, no iteration. The SQL syntax differs per engine, but the Rust core resolution logic is shared.

### Rollback

Rollback is an INSERT, not an UPDATE — the commit log is append-only:

```sql
-- Roll back user_stats to version 2
INSERT INTO lattik_table_commits (table_name, manifest_version, manifest_load_id)
SELECT table_name, (SELECT max(manifest_version) + 1 FROM lattik_table_commits WHERE table_name = 'user_stats'),
       manifest_load_id
FROM lattik_table_commits
WHERE table_name = 'user_stats' AND manifest_version = 2;
```

This creates a new commit (e.g., v4) that points to the same manifest as v2. Readers immediately see the rolled-back state. The rollback itself is recorded in the audit trail.

### Bucketing contract

All loads for a given Lattik Table MUST share:

| Property | Value | Rationale |
|---|---|---|
| **Bucket counts** | Power of 2 per PK column level, **auto-determined per load** | Hierarchical bucketing enables shuffle-less cross-table joins |
| **Hash function** | `xxhash64` per column, combined hierarchically | Each PK column hashed independently |
| **PK column names** | Normalized to the Lattik Table's PK names | `key_mapping` applied at write time |
| **File format** | Per-load (recorded in `load.json`) | Different loads can use different formats |

### Hierarchical bucketing

For composite PKs, each PK column is hashed independently and the hashes are combined into a **hierarchical bucket address**. This enables shuffle-less joins between tables that share a common PK prefix.

**Single PK column** (e.g., `user_id`):

```
bucket = xxhash64(user_id) % bucket_count
```

Same as before — flat bucketing.

**Composite PK** (e.g., `[user_id, game_id]`):

Each PK column gets its own bucket level, each a power of 2:

```
level_1 = xxhash64(user_id) % 32      ← user-level bucket
level_2 = xxhash64(game_id) % 4       ← game-level sub-bucket within user bucket
physical_bucket = level_1 * 4 + level_2   ← 128 total buckets (32 × 4)
```

The physical bucket is a composite: `(level_1 × sub_count) + level_2`. The `load.json` records the per-level bucket counts:

```json
{
  "load_id": "e5f6g7h8",
  "bucket_levels": [32, 4],
  "bucket_count": 128,
  ...
}
```

**Why this enables shuffle-less cross-table joins:**

Consider two tables:
- Table 1: PK `[user_id, game_id]`, bucket_levels `[32, 4]` → 128 physical buckets
- Table 2: PK `[user_id]`, bucket_levels `[32]` → 32 physical buckets

Joining on `user_id`:

```
Table 1 (128 buckets = 32 user × 4 game):

  user_bucket=10, game_sub=0  → physical 40 ──┐
  user_bucket=10, game_sub=1  → physical 41 ──┤
  user_bucket=10, game_sub=2  → physical 42 ──┼── all join with Table 2 bucket 10
  user_bucket=10, game_sub=3  → physical 43 ──┘

Table 2 (32 buckets):
  bucket=10 ← same user_id range
```

All rows for a given `user_id` range in Table 1 are in a known, contiguous set of physical buckets (40-43). The reader reads those 4 buckets from Table 1 and joins with 1 bucket from Table 2. **No shuffle** — the join key alignment is guaranteed by the first-level hash.

This generalizes to deeper composites:

```
Table A: PK [user_id, game_id, session_id], levels [32, 4, 8] → 1024 buckets
Table B: PK [user_id, game_id],            levels [32, 4]     → 128 buckets
Table C: PK [user_id],                     levels [32]         → 32 buckets

Join A × B on (user_id, game_id): Table A buckets [b*8 .. b*8+7] ↔ Table B bucket b
Join A × C on (user_id):          Table A buckets [b*32 .. b*32+31] ↔ Table C bucket b
Join B × C on (user_id):          Table B buckets [b*4 .. b*4+3] ↔ Table C bucket b
```

**Power-of-2 alignment applies independently at every level.** Different loads can have different bucket counts at each level — as long as each count is a power of 2, the reader maps between them with `% coarser_count` at that level.

```
Load X: bucket_levels [64, 8]    Load Y: bucket_levels [32, 4]

Level 1 alignment (user):
  Load X user_bucket 42  ──────────▶  Load Y user_bucket 42 % 32 = 10

Level 2 alignment (game):
  Load X game_sub 5      ──────────▶  Load Y game_sub 5 % 4 = 1

Physical bucket mapping:
  Load X physical (42 * 8 + 5 = 341)  →  Load Y physical (10 * 4 + 1 = 41)
```

This means auto-bucketing can independently size each level per load. A load with 10x more data can double its level-2 count from 4 to 8 without affecting other loads — the reader still aligns correctly.

**Cross-table joins also use per-level alignment.** When joining a `[user_id, game_id]` table (levels `[32, 8]`) with a `[user_id]` table (levels `[64]`), the reader aligns on the first level:

```
Table 1: user_bucket = xxhash64(user_id) % 32 = 10, game_sub = 0..7
Table 2: user_bucket = xxhash64(user_id) % 64

Table 2 buckets 10 and 42 (10 + 32) both align with Table 1 user_bucket 10
  because 10 % 32 = 10 and 42 % 32 = 10.
```

The alignment rule is the same everywhere: `coarser_bucket = finer_bucket % coarser_count`, applied per level.

### Auto-bucketing

The bucket count **per level** is determined automatically by the batch writer based on data volume and cardinality. The total physical bucket count is the product of all levels.

```python
def determine_bucket_levels(df, pk_columns, target_bucket_size):
    """Auto-determine per-level bucket counts for hierarchical bucketing."""
    total_size = estimate_size(df)
    total_buckets = next_power_of_2(total_size / target_bucket_size)
    total_buckets = max(1, min(total_buckets, 4096))

    if len(pk_columns) == 1:
        return [total_buckets]

    # Distribute buckets across levels.
    # First level (entity key) gets most of the buckets.
    # Subsequent levels subdivide within that.
    # Heuristic: sqrt split, rounded to powers of 2.
    level_1 = next_power_of_2(int(total_buckets ** 0.5))
    level_2 = max(1, total_buckets // level_1)
    if len(pk_columns) == 2:
        return [level_1, level_2]

    # For 3+ PK columns, split level_2 further
    level_2_sub = next_power_of_2(int(level_2 ** 0.5))
    level_3 = max(1, level_2 // level_2_sub)
    return [level_1, level_2_sub, level_3]
```

**Sizing examples (2-column PK):**

| Total data | `target_bucket_size` | Total buckets | Level 1 (entity) | Level 2 (sub) |
|---|---|---|---|---|
| 500MB | 128MB | 4 | 2 | 2 |
| 5GB | 128MB | 64 | 8 | 8 |
| 50GB | 128MB | 512 | 32 | 16 |
| 500GB | 128MB | 4096 | 64 | 64 |

### Per-load file schemas

Each load stores **both a delta and a cumulative** for columns that use merge strategies. The delta contains only this period's contribution; the cumulative contains the merged result through this ds. Queries read the cumulative; backfills use the delta to re-derive downstream cumulative values without re-reading source events.

**`data.<ext>`** — the load's column data:
- **PK columns** — named after the Lattik Table's PK (key_mapping already applied)
- **Cumulative columns** — the merged result through this ds (what queries read)
- **Delta columns** — this period's contribution only (used for cascading backfills)
- Files are partitioned into `bucket=NNNN/` directories by hierarchical bucket ID (see [Hierarchical bucketing](#hierarchical-bucketing))
- **Sort order depends on format:** sorted by PK for Parquet (`sorted: true`), unsorted for Vortex/Lance (`sorted: false`)

Delta columns are named `<column>__delta` by convention. They are physical columns in the data file but hidden from the query engine — only the batch writer reads them during backfills.

**`pk_index.<ext>`** — (optional) the PK-to-row-id mapping:
- Only present when `has_pk_index: true` (Vortex, Lance — formats with fast random access)
- Not present for Parquet (data is sorted instead)
- **PK columns** — same type as the data file's PK, **sorted ascending**
- **`row_id`** — `INT64`, position of the corresponding row in `data.<ext>`
- Because the index is sorted by PK, format-level statistics (e.g., Vortex zone maps) on the PK column are tight and non-overlapping, enabling near-binary-search efficiency for point and range lookups.

**Example: Vortex load** (unsorted data + PK index):

```
e5f6g7h8/bucket=0042/

data.vortex:
  user_id: INT64                              (PK)
  lifetime_revenue: DOUBLE                    (cumulative: sum through this ds)
  lifetime_revenue__delta: DOUBLE             (delta: sum for this ds only)
  purchase_count: INT64                       (cumulative)
  purchase_count__delta: INT64                (delta)
  daily_purchase_activity: BINARY             (cumulative: bitmap through this ds)
  daily_purchase_activity__delta: BINARY      (delta: bitmap for this ds only)
  -- unsorted

pk_index.vortex:
  user_id: INT64                              (PK, sorted ascending)
  row_id: INT64                               (position in data.vortex)
```

**Example: Parquet load** (sorted data, no sidecar):

```
j3k4l5m6/bucket=0042/

data.parquet:
  user_id: INT64                              (PK)
  home_country: STRING                        (cumulative: prepend_list, max_length=1)
  home_country__delta: STRING                 (delta: this period's values)
  -- sorted by user_id ascending
```

**How delta + cumulative work per strategy:**

| Strategy | Delta (`<col>__delta`) | Cumulative (`<col>`) | Backfill recompute |
|---|---|---|---|
| **Lifetime Window (`sum`)** | `sum(amount)` for events in this ds only | Running total through this ds | `new_cumulative = prev_ds.cumulative + new_delta` |
| **Lifetime Window (`max`)** | `max(score)` for events in this ds only | All-time max through this ds | `new_cumulative = max(prev_ds.cumulative, new_delta)` |
| **Lifetime Window (`count`)** | `count()` for events in this ds only | Running count through this ds | `new_cumulative = prev_ds.cumulative + new_delta` |
| **Prepend List** | This period's new values | Full list (most recent first, truncated) | `new_cumulative = (new_delta ++ prev_ds.cumulative)[:max_length]` |
| **Bitmap Activity** | This period's activity bits | OR of all periods' bits | `new_cumulative = prev_ds.cumulative OR new_delta` |

### Backfill with cascading recompute

When backfilling `ds=2026-04-05`:

```
1. Recompute the DELTA from source events for 04-05 only (cheap — one period)
2. Read the CUMULATIVE from the previous ds (04-04's load)
3. Compute new CUMULATIVE: prev_cumulative + new_delta (per strategy)
4. Write new load for ds=04-05 (both delta and cumulative)
5. CASCADE: for each subsequent ds (04-06, 04-07, ..., today):
   a. Read the EXISTING DELTA from that ds's load (already stored, no source re-read)
   b. Read the NEW CUMULATIVE from the previous ds
   c. Recompute: new_cumulative = prev_cumulative + existing_delta
   d. Write new load for that ds (reuse existing delta, new cumulative)
```

The cascade only recomputes cumulative values using already-stored deltas — **no source events are re-read** for downstream ds values. Only the backfilled ds itself reads source data.

**Cost of a backfill:**
- Re-reading source events: only for the backfilled ds (one period)
- Cascading recompute: one read + one write per downstream ds, using stored deltas
- No downstream source re-reads

### Garbage collection

Load folders not referenced by any retained snapshot can be safely deleted. A retention policy (e.g., "keep snapshots for 90 days") controls what's retained. GC walks all live snapshots in the manifest, collects referenced load IDs, and deletes orphaned load folders.

## The stitch algorithm

### Stage 1: Per-family aggregation (write time, batch job)

For each column family, the batch job reads the source table, applies key_mapping to normalize join keys, and produces two values per column: a **delta** (this period's contribution) and a **cumulative** (merged result through this ds). Both are written to the load's data files. Queries read the cumulative; backfills use the delta for efficient cascading recompute.

Given this family spec:

```yaml
column_families:
  - name: purchases
    source: ingest.purchases
    key_mapping: { user_id: actor_id }
    columns:
      - name: lifetime_revenue
        strategy: lifetime_window
        agg: sum(amount)
      - name: purchase_count
        strategy: lifetime_window
        agg: count()
      - name: recent_products
        strategy: prepend_list
        expr: product_id
        max_length: 20
      - name: daily_purchase_activity
        strategy: bitmap_activity
        granularity: day
        window: 365
```

The batch job generates the aggregation query based on each column's strategy:

```python
# Read source, aggregate per strategy
delta = aggregate_family(spark, family_spec, time_filter=(hwm, ds))

# Bucket and write to S3 as a new immutable load
write_load(delta, "s3://warehouse/lattik/user_stats",
           pk_columns=["user_id"], column_names=["lifetime_revenue", ...],
           format_id="vortex", target_bucket_size=128*1024*1024)
```

See [Batch materialization](#execution-path-batch-materialization) below for forward runs and backfill strategies.

### Column strategies

Each column declares a **strategy** that defines both how source events are aggregated and how the result is stored:

**Lifetime Window** — scalar aggregation over all source events.

```yaml
- name: lifetime_revenue
  strategy: lifetime_window
  agg: sum(amount)           # lattik-expression: the aggregation function
```

Each load produces two physical columns:
- **Delta** (`lifetime_revenue__delta`): the `agg` expression applied to source events *in this ds only*
- **Cumulative** (`lifetime_revenue`): `prev_ds.cumulative MERGE delta` where MERGE depends on the agg function:
  - `sum(x)` → `prev + delta`
  - `count()` → `prev + delta`
  - `max(x)` → `max(prev, delta)`
  - `min(x)` → `min(prev, delta)`

Queries read the cumulative column. The delta is stored for cascading backfills.

**Prepend List** — bounded ordered list of recent values.

```yaml
- name: recent_countries
  strategy: prepend_list
  expr: country              # lattik-expression: the value to collect
  max_length: 10             # keep at most this many entries
```

Each load produces two physical columns:
- **Delta** (`recent_countries__delta`): this period's new values
- **Cumulative** (`recent_countries`): `(delta ++ prev_ds.cumulative)[:max_length]`

Queries read the cumulative column. To get "the most recent country," use a Prepend List of length 1 with `max_by(country, event_timestamp)` — read `list[0]`.

**Bitmap Activity** — bitfield tracking entity activity per time slot.

```yaml
- name: daily_activity
  strategy: bitmap_activity
  granularity: day           # one bit per day
  window: 365                # track 365 days
```

Each load produces two physical columns:
- **Delta** (`daily_activity__delta`): bitmap with only this period's bits set
- **Cumulative** (`daily_activity`): `prev_ds.cumulative OR delta`, with expired bits shifted out beyond `window`

Queries read the cumulative column. Enables efficient computation of DAU/WAU/MAU, streaks, churn, etc.

### Stage 2: Cross-family stitch (read time, PartitionReader)

At read time, the Data Source V2 PartitionReader stitches families using a pluggable `Stitcher`. It reads data files directly from S3 via the configured `FamilyFormat` — no Iceberg API involved.

The stitcher is chosen based on the query pattern:

**Full scan / low selectivity → `NaiveStitcher` (v1 default):**

```
NaiveStitcher(bucket=b):
  // Phase 1: Read all loads sequentially, index by PK
  index = OrderedMap<PK, Map<loadId, Row>>()
  for each load:
    reader = format.openBucket("s3://.../loads/{load_id}/bucket=00b/", schema, ...)
    for each batch in reader.scan_data():
      for each row in batch:
        index[row.pk][load.id] = row

  // Phase 2: Emit stitched ColumnarBatches
  outputBatch = new ColumnarBatch(outputSchema, batchSize=4096)
  for each pk in index:
    for each load:
      if index[pk] has load → copy columns
      else → NULLs                                  ← FULL OUTER JOIN
    append to outputBatch
    if outputBatch.full() → yield outputBatch, start new one
```

Properties:
- **Time:** O(total rows across all families)
- **Memory:** O(rows in one bucket across all families) — fits in memory since bucket = 1/N of total
- **No sort requirement** — data files can be in any order
- **FULL OUTER JOIN semantics** — every PK from any family appears in the output

**Point/range lookup → `IndexedStitcher` (future, zero-copy):**

The `IndexedStitcher` is designed for **zero data copying** during the stitch. Column bytes flow from S3 → Vortex read buffer → Spark with no intermediate copies. The stitch is purely a metadata operation (building mapping vectors).

```
IndexedStitcher(bucket=b, pkFilter):
  // Phase 1: Probe each load's PK index for matching row_ids
  for each load:
    reader = format.openBucket("s3://.../loads/{load_id}/bucket=00b/", schema, ...)
    matches[load] = reader.probe_index(pkFilter)  // → [(pk, row_id), ...] via zone-map prune

  // Phase 2: Compute union PKs and per-load mappings
  union_pks = sorted union of all PKs across loads        // e.g., [100, 205, 317, 442]
  for each load:
    mapping[load] = int[union_pks.length]                 // output_pos → fetched_pos
    for i, pk in enumerate(union_pks):
      if pk in matches[load]:
        mapping[load][i] = position of pk in matches[load]
      else:
        mapping[load][i] = -1                             // NULL (FULL OUTER JOIN)

  // Phase 3: Batch-fetch from each load's data file (zero-copy into Arrow buffers)
  for each load:
    row_ids = [matches[load][pk].row_id for pk in union_pks if pk in matches[load]]
    fetched[load] = reader.fetch_rows(row_ids, schema)    // → RecordBatch

  // Phase 4: Assemble zero-copy output
  output = new RecordBatch(outputSchema, union_pks.length)
  output.pk_column = Array.from(union_pks)                // only PK is constructed
  for each load:
    for each col in load.columns:
      output.add(MappedArray(fetched[load].col(col), mapping[load]))  // zero-copy
  return output
```

**`MappedColumnVector`** — the zero-copy indirection layer:

```java
/**
 * Wraps a family's ColumnVector with a position mapping.
 * Reads are redirected to the delegate vector via the mapping.
 * Data bytes are never copied — the delegate's buffers are referenced directly.
 */
class MappedColumnVector extends ColumnVector {
    final ColumnVector delegate;  // family's column data (Arrow/Vortex buffer)
    final int[] mapping;          // output_pos → delegate_pos, -1 = NULL

    @Override boolean isNullAt(int rowId) {
        return mapping[rowId] == -1 || delegate.isNullAt(mapping[rowId]);
    }

    @Override int getInt(int rowId) {
        return delegate.getInt(mapping[rowId]);
    }

    @Override long getLong(int rowId) {
        return delegate.getLong(mapping[rowId]);
    }

    @Override double getDouble(int rowId) {
        return delegate.getDouble(mapping[rowId]);
    }

    @Override UTF8String getUTF8String(int rowId) {
        return delegate.getUTF8String(mapping[rowId]);
    }

    // ... same pattern for all types. Every access is a single
    // array lookup + delegation. No memcpy, no buffer allocation.
}
```

**What's allocated vs what's zero-copy:**

| Data | Size | Copied? |
|---|---|---|
| Family column bytes | MB–GB (actual data) | **No** — referenced via `MappedColumnVector.delegate` |
| Mapping vectors | 4 bytes × output_rows × num_families | Yes — tiny (80KB for 4096 rows × 5 families) |
| PK column | 8 bytes × output_rows | Yes — constructed once from union PKs |
| Vortex read buffers | Same as column bytes | Pinned in memory until batch is consumed |

Properties:
- **Zero-copy** — column data stays in Vortex/Arrow read buffers, never moved
- **Time:** O(matched rows) — only reads what the predicate selects
- **Memory:** O(matched rows) for the read buffers + O(output_rows × num_families × 4 bytes) for mappings
- **Leverages PK index** — sorted index + zone maps give near-binary-search pruning
- **Leverages Vortex random access** — 100x faster than Parquet for fetching individual rows

**Single-family optimization.** When column pruning determines only one family is needed, both stitchers skip the merge entirely — the `SingleFamilyPassthrough` stitcher passes the family's column vectors directly into the output batch with NULL column vectors for absent families. This is also zero-copy.

### Stage 3: Derived columns (read time, PartitionReader)

After stitching, the PartitionReader computes derived columns on each emitted `ColumnarBatch`:

```
batch["avg_order_value"] = batch["lifetime_revenue"] / batch["purchase_count"]
```

Derived column expressions are lattik-expressions evaluated per-`RecordBatch` after the stitcher produces it. The evaluation can happen in Rust (if the expression engine is ported) or in the JVM wrapper (using `@eloquio/lattik-expression`). Since derived columns can reference columns from ANY load, they must be computed after the stitch.

## Implementation architecture: Rust core + JVM wrappers

The stitch engine is implemented in **Rust**, with thin JVM wrappers for Spark and Trino. The heavy lifting (file reading, PK index probing, stitching, zero-copy assembly) runs as native code. The JVM layer is purely interface adaptation — no data processing logic.

```
┌─────────────────────────────────────────────────┐
│                  Rust Core                       │
│              lattik-stitch (crate)               │
│                                                  │
│  FamilyFormat (Parquet, Vortex, Lance readers)   │
│  Stitcher (NaiveStitcher, IndexedStitcher)       │
│  MappedColumnVector / zero-copy assembly         │
│  PK index probing                                │
│  Manifest + load.json parsing                    │
│  Bucket alignment                                │
│  Arrow output via C Data Interface               │
└──────────┬──────────────────┬────────────────────┘
           │ JNI              │ JNI
┌──────────▼──────┐  ┌───────▼──────────┐
│ lattik-spark    │  │ lattik-trino     │
│ (Kotlin)        │  │ (Java)           │
│                 │  │                  │
│ Thin wrappers:  │  │ Thin wrappers:   │
│ TableCatalog    │  │ ConnectorFactory │
│ ScanBuilder     │  │ ConnectorSplit   │
│ PartitionReader │  │ PageSource       │
│ ColumnVector    │  │ Block            │
└─────────────────┘  └──────────────────┘
```

### Why Rust

- **Vortex and Lance are Rust-native.** Reading Vortex files from Rust is a direct function call — no JNI overhead for the most performance-critical path.
- **Parquet via `arrow-rs` / `parquet-rs`** — also native Rust, no `parquet-mr` needed.
- **Zero-copy across the Rust/JVM boundary** via the [Arrow C Data Interface](https://arrow.apache.org/docs/format/CDataInterface.html). Rust produces Arrow `RecordBatch`es → exports as C struct pointers → JVM wraps as Spark `ColumnVector` or Trino `Block` without copying data. Memory is freed when the JVM wrapper is closed.
- **No GC pauses** during the data path. The stitch loop runs entirely in Rust-managed memory.
- **Write once, run everywhere.** The stitch logic is shared between Spark and Trino via the same JNI bridge.

### Crate structure

```
lattik-stitch/
  Cargo.toml
  crates/
    lattik-stitch-core/       ← stitcher, PK index, bucket alignment, manifest parsing
    lattik-format-vortex/     ← FamilyFormat impl for Vortex (depends on vortex crate)
    lattik-format-parquet/    ← FamilyFormat impl for Parquet (depends on arrow-rs/parquet-rs)
    lattik-format-lance/      ← FamilyFormat impl for Lance (depends on lance crate)
    lattik-stitch-jni/        ← JNI bridge, Arrow C Data Interface export
  java/
    lattik-spark/             ← Kotlin, Spark DS V2 thin wrappers (~300 lines)
    lattik-trino/             ← Java, Trino connector thin wrappers (~300 lines)
```

### What lives where

| Component | Language | Rationale |
|---|---|---|
| Stitch engine (stitchers, PK index, bucket alignment) | Rust | Performance-critical, written once, shared |
| FamilyFormat readers (Vortex, Parquet, Lance) | Rust | Native access to Rust-native formats |
| Manifest + load.json parsing | Rust | Shared across engines |
| MappedColumnVector / zero-copy assembly | Rust | Produces Arrow arrays via C Data Interface |
| JNI bridge (`lattik-stitch-jni`) | Rust + JNI | Thin FFI layer |
| Spark CatalogPlugin, ScanBuilder, PartitionReader | Kotlin | Spark API adaptation only |
| Trino Connector, PageSource | Java | Trino API adaptation only |
| Batch writer (the driver) | PySpark (v1) / Rust (future) | PySpark for v1 simplicity |

### Data flow (zero-copy from S3 to query engine)

```
S3                → Rust (lattik-stitch-core)     → JVM (lattik-spark / lattik-trino)
                    │                                │
Vortex/Parquet    → FamilyFormat reads files       → Arrow C Data Interface export
file bytes          into Arrow RecordBatches          (just pointers, no copy)
                    │                                │
                    Stitcher combines batches       → Spark ColumnarBatch / Trino Page
                    via MappedColumnVector             wraps the Arrow pointers
                    (zero-copy: mapping vectors       │
                     only, no data movement)         → Query engine consumes rows
```

The only data copy in the entire path is the mapping vectors (4 bytes × output_rows × num_loads) and the PK column. Column data flows from S3 through Rust read buffers directly to the query engine.

## Spark integration: Data Source V2

The Spark integration is a thin Kotlin wrapper over the Rust core. All components below delegate to `lattik-stitch-jni` for the actual data work.

### Components

**1. `LattikSparkExtension`** — implements `SparkSessionExtensions => Unit`

Registered via:
```
spark.sql.extensions = com.eloquio.lattik.spark.LattikSparkExtension
```

Registers `LattikCatalog` as a catalog plugin.

**2. `LattikCatalog`** — implements `TableCatalog`

Registered via:
```
spark.sql.catalog.lattik = com.eloquio.lattik.spark.LattikCatalog
spark.sql.catalog.lattik.warehouse   = s3://warehouse
spark.sql.catalog.lattik.jdbc-url    = jdbc:postgresql://localhost:5432/lattik_studio
```

`loadTable(ident)`:
1. Queries `lattik_table_commits` for the latest (or time-travel target) version
2. Fetches `s3://warehouse/lattik/<table_name>/manifests/v<N>_<load_id>.json`
3. Parses the Lattik Table spec and snapshot data
4. Returns a `LattikStitchedTable`

`listTables()` / `tableExists()`: Queries the `lattik_table_commits` table in Postgres.

**3. `LattikStitchedTable`** — implements `Table`, `SupportsRead`

Holds:
- The parsed Lattik Table spec (families, PK, derived columns, bucket_count)
- The computed stitched `StructType` (PK columns + all family columns + derived columns)
- The S3 base path for this table's family data

**4. `LattikScanBuilder`** — implements `ScanBuilder`, `SupportsPushDownRequiredColumns`, `SupportsPushDownFilters`

Accepts:
- **Required columns** → determines which families need to be read. If the query only needs columns from one family, other families are skipped entirely.
- **PK filters** → accepted and pushed down. Used for bucket pruning and, when the `IndexedStitcher` is selected, for PK index probing within buckets.
- **Non-PK filters** → rejected (applied post-scan by Spark). The stitch output has FULL OUTER JOIN semantics, so pre-stitch filtering on non-PK columns would be incorrect.

**Query governance — `SELECT *` rejection:**

`LattikScanBuilder.pruneColumns()` enforces a hard rule: if the projected columns would require stitching more than `max-stitch-loads` distinct loads (default: 3), the scan is rejected with an error:

```
SELECT * on lattik.user_stats requires stitching 6 loads.
Max allowed without explicit column selection: 3.
Specify the columns you need:
  SELECT user_id, home_country, lifetime_revenue FROM lattik.user_stats
```

The cost of a query is driven by the number of distinct loads to stitch, not the number of columns. Reading 50 columns from 1 load is cheap (single sequential scan, no join). Reading 3 columns from 6 loads is expensive (6 file opens, 6 scans/index probes, a 6-way merge). The guardrail targets the expensive case.

Note: explicit queries that name columns spanning many loads are always allowed — the guardrail only applies to `SELECT *` (i.e., when no column pruning is possible). If a user writes `SELECT col_a, col_b, col_c FROM ...` and those columns happen to touch 6 loads, that's an intentional choice.

The threshold is configurable via Spark catalog config:
```
spark.sql.catalog.lattik.max-stitch-loads = 3
```
Set to `0` to disable the check entirely (not recommended for production).

**5. `LattikScan` / `LattikBatch`**

`planInputPartitions()`:
1. Resolves the target snapshot (latest, or a specific timestamp for time-travel queries)
2. Maps requested columns → load IDs from the snapshot. Groups columns by load ID.
3. Fetches `load.json` for each unique load ID → gets `bucket_count` and `format` per load (cached).
4. Computes `maxBuckets = max(load.bucket_count for each needed load)` — the finest granularity
5. For each bucket `b` in `[0, maxBuckets)`:
   - If PK filter prunes this bucket → skip
   - For each needed load: compute `loadBucket = b % load.bucket_count`
   - Create `StitchPartition(bucket=b, loads=[{..., bucketPath=.../loads/<uuid>/bucket={loadBucket}/, format=load.format}])`
6. Returns the array of `StitchPartition`s

Note: multiple fine-grained partitions may point to the same coarse-load bucket. The stitcher handles this correctly — it reads the full coarse bucket and joins against the subset of PKs in the fine-grained bucket.

**6. `StitchPartition`** — implements `InputPartition`, `Serializable`

Carries:
- `bucketId: Int`
- `loadSpecs: Array[LoadPartitionSpec]` — for each needed load:
  - `path: String` (e.g., `s3://warehouse/lattik/user_stats/loads/e5f6g7h8/bucket=0042/`)
  - `columns: Array[String]` (needed columns from this load)
  - `pkColumns: Array[String]`
  - `schema: StructType` (projected Spark schema for these columns)
  - `formatId: String` (e.g., `"parquet"`, `"lance"`, `"vortex"` — from `load.json`)
- `derivedColumns: Array[DerivedColumnSpec]` (name + compiled expression)
- `stitcherId: String` (e.g., `"naive"`, `"indexed"`)
- `s3Config: S3Config` (endpoint, credentials)

**7. `StitchPartitionReaderFactory` / `StitchPartitionReader`**

The reader runs on a Spark executor, produces **`ColumnarBatch`** for vectorized execution. The Kotlin wrapper delegates to the Rust core via JNI — all file I/O, stitching, and zero-copy assembly happens in Rust:

```
StitchPartitionReader(partition) implements PartitionReader<ColumnarBatch>:
  // Create a Rust-side stitch session via JNI
  // The Rust core opens format readers, creates the stitcher, and manages all buffers
  rustSession = LattikStitchJni.createSession(
    partition.loadSpecs,         // load paths, columns, formats
    partition.pkColumns,
    partition.stitcherId,
    partition.pkFilter,
    partition.s3Config
  )

  next():
    return rustSession.hasNext()         // JNI call → Rust

  get():
    // Rust produces an Arrow RecordBatch, exports via C Data Interface
    // Kotlin wraps the Arrow pointers as a Spark ColumnarBatch (zero-copy)
    arrowBatch = rustSession.nextBatch() // JNI call → Rust → Arrow C Data Interface
    batch = ArrowColumnVector.wrap(arrowBatch)
    applyDerivedColumns(batch, partition.derivedColumns)
    return batch

  close():
    rustSession.close()                  // releases Rust-side buffers
```

The `Scan` declares columnar support:

```kotlin
class LattikScan : Scan, Batch {
    override fun supportColumnarReads() = true
    // ...
}
```

### Column pruning walkthrough

Query: `SELECT user_id, home_country FROM lattik.user_stats`

1. `SupportsPushDownRequiredColumns.pruneColumns()` receives `[user_id, home_country]`
2. `LattikScanBuilder` maps columns to families:
   - `user_id` → PK (present in all families)
   - `home_country` → signups family only
3. `LattikBatch.planInputPartitions()` creates partitions with only the signups family
4. Each `StitchPartitionReader` opens only the signups family's `data.<ext>` — no stitch needed
5. Purchases family is never touched

### Predicate pushdown walkthrough

Query: `SELECT * FROM lattik.user_stats WHERE user_id = 42`

1. `SupportsPushDownFilters.pushFilters()` receives `[user_id = 42]`
2. PK filter accepted → stored for bucket pruning; high selectivity → selects `IndexedStitcher`
3. `planInputPartitions()`:
   - Computes `targetBucket = xxhash64(42) % 128`
   - Creates only ONE `StitchPartition(bucket=targetBucket, stitcher="indexed", pkFilter=42)`
   - 127 out of 128 buckets are pruned
4. `IndexedStitcher` within the bucket:
   - Probes each family's `pk_index.<ext>` — zone maps on the sorted PK column prune to the relevant zone
   - Scans the zone, finds `row_id` for PK=42
   - Random-accesses `data.<ext>` at that `row_id` (Vortex: 100x faster than Parquet)
   - Assembles the stitched row across families

## Execution path: Batch materialization

The batch path runs periodically (triggered by Airflow), reads new source data, and writes pre-aggregated results to a new **load folder** on S3. Each load is immutable — the writer never modifies existing load folders.

### Load lifecycle

```
1. Generate a UUID for this load
2. For each column family being loaded:
   a. Read source data, apply key_mapping, aggregate by PK per column strategy
   b. If incremental: read the previous load's data for affected buckets,
      merge existing + delta per column strategy
   c. Auto-determine bucket_count from data size
   d. Write bucketed data + PK index to s3://.../loads/<uuid>/
3. Append a new snapshot to manifest.json:
   - For columns produced by this load: point to the new load UUID
   - For columns NOT produced by this load: carry forward from the previous snapshot
```

### Forward run (normal cadence)

Each forward run processes one ds and produces both delta and cumulative:

```
For each family independently:
  1. Generate load UUID
  2. Read source events for this ds only (e.g., WHERE ds = '2026-04-10')
  3. Apply key_mapping, compute DELTA per column strategy (agg over this period)
  4. Read the previous ds's load → get CUMULATIVE values
  5. Compute new CUMULATIVE: prev_cumulative MERGE delta (per strategy)
  6. Auto-determine bucket_count, write both delta + cumulative to loads/<uuid>/
  7. Commit: manifest + lattik_table_commits + lattik_column_loads
```

**Each family is loaded independently.** There is no cross-family join at write time — that happens at read time via the stitcher. This means:
- Families can run at different cadences (one hourly, one daily)
- A late-arriving family doesn't block others
- Each family load is a smaller, focused operation

### Backfill

Backfills are structurally different from forward runs — different parallelism, different dependency chains, different source data ranges. They are defined as a **backfill plan** in the Lattik Table spec and generate a dedicated Airflow DAG.

**No full rebuilds.** Source data has retention policies (e.g., 90 days). Events older than the retention window are gone. A backfill always operates on a date range (`ds_start` to `ds_end`) and builds forward from a seed — the cumulative value at `ds_start - 1`.

#### Backfill plan (in the Lattik Table spec)

```yaml
name: user_stats
# ... primary_key, column_families, derived_columns ...

backfill:
  lookback: 90d                  # default backfill window: start from 90 days ago
  parallelism: 4                 # max concurrent ds slots for independent columns
```

The backfill plan is optional. If omitted, defaults are `lookback: 30d`, `parallelism: 1`.

Triggered via:
```bash
# Backfill a specific date range
airflow dags trigger backfill__user_stats --conf '{"ds_start": "2026-04-01", "ds_end": "2026-04-10"}'

# Backfill using the default lookback window (today - 90d to today)
airflow dags trigger backfill__user_stats
```

#### Backfill strategies per family

The backfill DAG generator determines the optimal strategy for each family based on its column strategies:

**Strategy A: Sequential cascade** — for families with `lifetime_window` columns

Cumulative columns depend on the previous ds. Must process in order:

```
seed (ds=03-31 cumulative)
  → backfill ds=04-01 (read source + merge)
    → backfill ds=04-02 (read source + merge)
      → ...
        → backfill ds=04-10 (read source + merge)
          → cascade ds=04-11 (reuse stored delta + merge)
            → ...
              → cascade ds=today (reuse stored delta + merge)
```

For the backfilled range (`ds_start` to `ds_end`), each task:
1. Reads source events for that ds (compute new delta)
2. Reads previous ds's cumulative
3. Computes new cumulative
4. Writes load (both delta + cumulative)

For the cascade range (`ds_end + 1` to today), each task:
1. Reads the **existing stored delta** from that ds's current load (no source re-read)
2. Reads previous ds's new cumulative
3. Recomputes cumulative
4. Writes new load (reuse existing delta, new cumulative)

**Cost:** source re-read for `(ds_end - ds_start)` days + cascade recompute for `(today - ds_end)` days using stored deltas.

**Strategy B: Parallel fan-out** — for families with only `bitmap_activity` or `prepend_list` columns

These columns can be computed independently per ds (no cross-ds dependency for the delta). Each ds task runs in parallel up to the `parallelism` limit:

```
backfill ds=04-01 ──┐
backfill ds=04-02 ──┤
backfill ds=04-03 ──┼── parallel (up to parallelism=4)
backfill ds=04-04 ──┤
backfill ds=04-05 ──┘
                    └── final cumulative pass (sequential, using computed deltas)
```

Phase 1 (parallel): compute deltas from source for each ds independently.
Phase 2 (sequential): build cumulative values forward from the seed, using the freshly computed deltas. This pass is cheap — no source re-reads.

**Strategy C: Hybrid** — families with mixed column strategies

Some columns in the family need sequential cascade (`lifetime_window`), others can be parallel (`bitmap_activity`). The DAG generator handles this by:
1. Running the sequential cascade for the family (which produces deltas + cumulative for all columns)
2. The `lifetime_window` columns are correctly cascaded
3. The `bitmap_activity`/`prepend_list` deltas are recomputed from source in the same task (since we're reading source events for each ds anyway)

In practice, most families are either all-cumulative or all-independent, so the hybrid case is rare.

#### Generated backfill DAG

The DAG generator (`dag-generator.ts`) produces a dedicated `backfill__<table_name>` DAG:

```
backfill__user_stats (ds_start=2026-04-01, ds_end=2026-04-10):

  # Purchases family: has lifetime_window → Strategy A (sequential)
  seed(ds=03-31)
    → backfill__purchases__04-01
      → backfill__purchases__04-02
        → ...
          → backfill__purchases__04-10
            → cascade__purchases__04-11
              → ...
                → cascade__purchases__today

  # Signups family: prepend_list only → Strategy B (parallel + cumulative pass)
  backfill__signups__04-01 ─┐
  backfill__signups__04-02 ─┤
  ...                       ├── parallel (parallelism=4)
  backfill__signups__04-10 ─┘
                            └── cumulative__signups (sequential pass over deltas)
```

#### Seed resolution

For `depends_on_past` families, the cascade starts from a **seed** — the cumulative value at `ds_start - 1`.

| Scenario | Seed |
|---|---|
| Previous ds has a load | Read its cumulative |
| First-ever run (no previous ds) | Zero/empty (e.g., `sum=0`, empty list, empty bitmap) |
| Previous ds is also being backfilled | The backfill range is extended backward to include it |

The `lookback` setting in the backfill plan sets the maximum window. If the user requests a `ds_start` older than `today - lookback`, the engine warns:
```
Backfill ds_start=2025-01-01 exceeds lookback window (90d).
Source data before 2026-01-10 may not be available due to retention policy.
```

### Write-time bucketing and indexing

The batch job controls the physical layout. It computes hierarchical bucket IDs per row, shuffles data into buckets via Spark, then delegates the actual file writing to the Rust core via JNI. Spark's built-in `partitionBy` only supports flat partitioning, so we compute the composite bucket ID as an explicit column and use `foreachPartition` to hand data to the Rust writer.

```python
from pyspark.sql import functions as F
import math, uuid

def next_power_of_2(n):
    return 1 if n <= 1 else 2 ** math.ceil(math.log2(n))

def write_load(df, table_path, pk_columns, column_names, format_id, target_bucket_size):
    """Write a DataFrame as a new immutable load to S3."""
    load_id = str(uuid.uuid4())
    load_path = f"{table_path}/loads/{load_id}"

    # Auto-determine hierarchical bucket levels
    bucket_levels = determine_bucket_levels(df, pk_columns, target_bucket_size)
    total_buckets = 1
    for lvl in bucket_levels:
        total_buckets *= lvl

    format = FamilyFormatFactory.create(format_id)
    use_pk_index = format.supports_random_access()
    sort_data = not use_pk_index

    # Compute hierarchical bucket ID per row
    # Each PK column gets its own hash level; combined into a single physical bucket ID
    df_bucketed = df
    sub_count = 1  # accumulator for computing physical bucket
    for i in reversed(range(len(pk_columns))):
        col = pk_columns[i]
        lvl = bucket_levels[i]
        level_col = f"_bucket_l{i}"
        df_bucketed = df_bucketed.withColumn(level_col, F.abs(F.xxhash64(col)) % F.lit(lvl))
        if i == len(pk_columns) - 1:
            df_bucketed = df_bucketed.withColumn("_bucket", F.col(level_col))
        else:
            df_bucketed = df_bucketed.withColumn("_bucket",
                F.col(level_col) * F.lit(sub_count) + F.col("_bucket"))
        sub_count *= lvl

    # Spark handles the shuffle — repartition by physical bucket ID
    df_bucketed = df_bucketed.repartition(total_buckets, "_bucket")
    if sort_data:
        df_bucketed = df_bucketed.sortWithinPartitions(*pk_columns)

    # Write load.json (self-describing metadata)
    write_s3_json(f"{load_path}/load.json", {
        "load_id": load_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "format": format_id,
        "bucket_levels": bucket_levels,
        "bucket_count": total_buckets,
        "sorted": sort_data,
        "has_pk_index": use_pk_index,
        "columns": column_names,
    })

    # Delegate file writing to the Rust core via JNI.
    # foreachPartition hands each partition (= one bucket) to the Rust writer,
    # which writes data.<ext> + pk_index.<ext> (if applicable) to the bucket dir.
    bucket_col = "_bucket"
    data_cols = pk_columns + column_names  # drop internal _bucket_l* columns

    def write_partition(partition_id, rows):
        LattikStitchJni.write_bucket(
            load_path=load_path,
            bucket_id=partition_id,
            rows=rows,
            columns=data_cols,
            format_id=format_id,
            pk_columns=pk_columns,
            write_pk_index=use_pk_index,
        )

    df_bucketed.select(*data_cols, bucket_col).foreachPartition(
        lambda rows: write_partition(rows)
    )

    return load_id
```

**What Spark does vs what Rust does:**

| Step | Spark (JVM) | Rust (via JNI) |
|---|---|---|
| Compute hierarchical bucket ID | `withColumn("_bucket", ...)` | — |
| Shuffle data into buckets | `repartition(total_buckets, "_bucket")` | — |
| Sort within bucket (Parquet only) | `sortWithinPartitions(*pk_columns)` | — |
| Write `data.<ext>` per bucket | — | `FamilyFormat.write_bucket()` or `write_bucket_with_index()` |
| Build + write `pk_index.<ext>` | — | Extracts (pk, row_id) pairs, sorts by PK, writes sidecar |

Spark handles the distributed shuffle (which is what it's good at). The Rust core handles the file I/O (format-specific writing, PK index construction).

> **Note:** The hash function (`xxhash64`) and the level computation must match between writer and reader. Both live in the Rust core — the PySpark driver calls `xxhash64` via Spark's built-in function, which uses the same algorithm as the Rust reader.

### Spark job: the driver

The batch job is what the Airflow DAG's `build__<table>` task runs. It processes each family independently, creating a new load for each:

```python
def build_lattik_table(spark, table_name, ds, hour, spec, format_id="vortex",
                       target_bucket_size=128 * 1024 * 1024):
    """
    ds/hour: the Airflow logical execution date (e.g., ds="2026-04-01", hour=None for daily).
    spec, format_id, target_bucket_size come from the job config / Airflow DAG params.
    """
    table_path = f"s3://warehouse/lattik/{table_name}"

    # Step 1: Read latest commit from Postgres
    base_version, base_load_id = db.query_one(
        "SELECT manifest_version, manifest_load_id "
        "FROM lattik_table_commits WHERE table_name = %s "
        "ORDER BY manifest_version DESC LIMIT 1", table_name
    )

    # Step 2: Write loads to S3 (immutable — this is the expensive step, done once)
    # Each load writes load.json + bucketed data (+ PK index if format supports it)
    load_results = {}  # family_name → (load_id, column_names)
    for family in spec["column_families"]:
        family_df = aggregate_family(spark, family)
        column_names = [col["name"] for col in family["columns"]]
        load_id = write_load(
            family_df, table_path,
            pk_columns=[pk["column"] for pk in spec["primary_key"]],
            column_names=column_names,
            format_id=format_id,
            target_bucket_size=target_bucket_size,
        )
        load_results[family["name"]] = (load_id, column_names)

    # Step 3: Build manifest and commit (with OCC retry)
    primary_load_id = list(load_results.values())[0][0]
    commit(table_name, table_path, spec, ds, hour,
           base_version, base_load_id, primary_load_id, load_results)

def commit(table_name, table_path, spec, ds, hour,
           base_version, base_load_id, our_load_id, load_results):
    """Build a new manifest, commit to both Postgres tables with OCC."""
    while True:
        # Read the base manifest's column map
        base_manifest = read_s3_json(
            f"{table_path}/manifests/v{base_version:04d}_{base_load_id}.json"
        )

        # Build new column map: carry forward base columns, override with our new loads
        new_column_map = dict(base_manifest.get("columns", {}))
        for family in spec["column_families"]:
            load_id, _ = load_results[family["name"]]
            for col in family["columns"]:
                new_column_map[col["name"]] = load_id

        # Write new manifest to S3 (immutable, single snapshot)
        new_version = base_version + 1
        write_s3_json(f"{table_path}/manifests/v{new_version:04d}_{our_load_id}.json", {
            "version": new_version,
            "columns": new_column_map,
        })

        # Atomic commit to both Postgres tables in one transaction
        try:
            with db.transaction():
                # 1. Insert into commit log (PK constraint = OCC)
                db.execute(
                    "INSERT INTO lattik_table_commits "
                    "(table_name, manifest_version, manifest_load_id) "
                    "VALUES (%s, %s, %s)",
                    table_name, new_version, our_load_id
                )

                # 2. Upsert per-column ETL time tracking
                for family in spec["column_families"]:
                    load_id, column_names = load_results[family["name"]]
                    for col_name in column_names:
                        db.execute(
                            "INSERT INTO lattik_column_loads "
                            "(table_name, column_name, ds, hour, load_id, manifest_version) "
                            "VALUES (%s, %s, %s, %s, %s, %s) "
                            "ON CONFLICT (table_name, column_name, ds, hour) DO UPDATE "
                            "SET load_id = EXCLUDED.load_id, "
                            "    manifest_version = EXCLUDED.manifest_version, "
                            "    committed_at = now()",
                            table_name, col_name, ds, hour, load_id, new_version
                        )
            return  # success — both tables committed atomically

        except UniqueViolation:
            pass  # conflict on lattik_table_commits — another writer committed first

        # Rebase: read the winner's version and retry.
        # Load data is already on S3 — only the manifest is regenerated.
        base_version, base_load_id = db.query_one(
            "SELECT manifest_version, manifest_load_id "
            "FROM lattik_table_commits WHERE table_name = %s "
            "ORDER BY manifest_version DESC LIMIT 1", table_name
        )
```

Both Postgres inserts happen in a single transaction — if the commit log INSERT succeeds, the column loads UPSERTs are guaranteed to succeed too (no PK conflict on that table thanks to `ON CONFLICT DO UPDATE`). If the commit log INSERT fails (OCC conflict), the whole transaction rolls back and neither table is affected.

**No cross-family join at write time.** Each family is self-contained. The stitch is purely a read-time concern.

## The FamilyFormat interface

The file format used for per-load storage is pluggable. The `FamilyFormat` trait (Rust) abstracts reading, writing, and index access so that the stitch logic is format-agnostic. The JNI bridge exposes these to the JVM, but the implementations are pure Rust.

### Interface (Rust traits)

```rust
/// Reads and writes columnar data for one load's bucket.
/// Implementations wrap a specific file format (Parquet, Vortex, Lance, etc.).
pub trait FamilyFormat: Send + Sync {
    /// Unique identifier (e.g., "parquet", "lance", "vortex").
    fn id(&self) -> &str;

    /// Whether this format supports fast random access (→ PK index sidecar).
    fn supports_random_access(&self) -> bool;

    /// Open a bucket for reading.
    fn open_bucket(
        &self,
        bucket_path: &str,
        schema: &Schema,        // Arrow schema (projected columns)
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<Box<dyn FamilyBucketReader>>;

    /// Write data + PK index for one bucket (Vortex, Lance).
    fn write_bucket_with_index(
        &self,
        bucket_path: &str,
        batches: Box<dyn Iterator<Item = RecordBatch>>,
        schema: &Schema,
        pk_columns: &[String],
        s3_config: &S3Config,
    ) -> Result<()>;

    /// Write data only, no PK index, for one bucket (Parquet — caller pre-sorts).
    fn write_bucket(
        &self,
        bucket_path: &str,
        batches: Box<dyn Iterator<Item = RecordBatch>>,
        schema: &Schema,
        s3_config: &S3Config,
    ) -> Result<()>;
}

/// Handle for reading a single load's bucket. Provides sequential scan
/// and optionally indexed access.
pub trait FamilyBucketReader: Send {
    /// Whether this load has sorted data (Parquet).
    fn is_sorted(&self) -> bool;

    /// Whether this load has a PK index sidecar (Vortex, Lance).
    fn has_pk_index(&self) -> bool;

    /// Sequential scan. Returns all rows in storage/sort order.
    fn scan_data(&self) -> Result<Box<dyn Iterator<Item = RecordBatch>>>;

    /// Probe the PK index for specific keys (only if has_pk_index()).
    fn probe_index(&self, predicate: &PkFilter) -> Result<Vec<(PkValue, u64)>>;

    /// Random-access read by row_id (only if has_pk_index()).
    /// Returned RecordBatch buffers are pinned — the IndexedStitcher
    /// references them via mapping vectors for zero-copy output.
    fn fetch_rows(&self, row_ids: &[u64], schema: &Schema) -> Result<RecordBatch>;
}
```

The JNI bridge (`lattik-stitch-jni`) wraps these traits and exports Arrow `RecordBatch`es to the JVM via the [Arrow C Data Interface](https://arrow.apache.org/docs/format/CDataInterface.html). The JVM side receives Arrow pointers and wraps them as Spark `ColumnVector` or Trino `Block` — zero-copy.

### Built-in implementations

| Format | `id()` | Library | `supportsRandomAccess()` | Write strategy | Read capabilities |
|---|---|---|---|---|---|
| **Parquet** | `"parquet"` | `parquet-mr` | `false` | Sorted data, no sidecar | `scanData()` (sorted); no `probeIndex`/`fetchRows` |
| **Lance** | `"lance"` | `lance` (Rust via JNI/FFI) | `true` | Unsorted data + PK index | `scanData()`, `probeIndex()`, `fetchRows()` |
| **Vortex** | `"vortex"` | `vortex-jni` (Rust via JNI) | `true` | Unsorted data + PK index | `scanData()`, `probeIndex()`, `fetchRows()` (zero-copy) |

Vortex is the recommended format because its fast random access makes the `IndexedStitcher` viable, and its compute-on-compressed-data pushes PK filter evaluation directly into the encoded index without decompression. Parquet is the fallback for maximum compatibility.

A table can have **mixed-format loads** — e.g., older Parquet loads (sorted, no sidecar) and newer Vortex loads (unsorted, with sidecar). The reader adapts per load based on the capabilities reported by `FamilyBucketReader`.

## The Stitcher interface

The stitch algorithm is pluggable. The Rust core delegates the actual batch combination to a **`Stitcher`** trait implementation. The JVM wrappers (Spark/Trino) don't interact with the stitcher directly — they call the JNI bridge which manages the stitcher internally.

### Interface (Rust trait)

```rust
/// Combines data from N load bucket readers into stitched Arrow RecordBatches.
pub trait Stitcher: Send {
    /// Initialize the stitcher with the load readers for one bucket.
    fn init(
        &mut self,
        readers: HashMap<String, Box<dyn FamilyBucketReader>>,
        pk_columns: &[String],
        output_schema: &Schema,
        pk_filter: Option<&PkFilter>,
    ) -> Result<()>;

    /// Returns true if another stitched batch is available.
    fn has_next(&self) -> bool;

    /// Returns the next stitched RecordBatch (PK columns + all load columns).
    /// Batch size is implementation-defined (typically 1024-4096 rows).
    fn next_batch(&mut self) -> Result<RecordBatch>;
}
```

### Built-in implementations

**`NaiveStitcher`** (v1 default) — Read all, hash-join in memory.

1. For each load: call `reader.scan_data()`, read all batches sequentially
2. Build `HashMap<PK, HashMap<load_id, row>>` across all loads
3. Iterate the key set, assemble stitched `RecordBatch`es (NULLs for missing loads)

Properties:
- O(total rows) time, O(rows in one bucket) memory
- No sort requirement — data files can be in any order
- FULL OUTER JOIN semantics (no rows dropped)
- Simple to implement, correct, good enough for v1

**`IndexedStitcher`** (future) — Zero-copy PK index probe + random access.

1. For each load with `has_pk_index()`: call `reader.probe_index(pk_filter)` to get matching `(pk, row_id)` pairs
2. For each load without `has_pk_index()` (Parquet): fall back to `scan_data()` with post-scan PK filter (data is sorted, so scan is still efficient)
3. Compute `union_pks` and per-load mapping vectors (`output_pos → fetched_pos`, `-1` = NULL)
4. For indexed loads: call `reader.fetch_rows(row_ids, schema)` — returns `RecordBatch` with pinned buffers
5. Assemble output `RecordBatch` using mapping vectors — wraps each load's Arrow arrays via index remapping, **zero data copy**

Properties:
- **Zero-copy** for indexed loads (Vortex/Lance) — column data stays in read buffers, never moved
- **Mixed-format aware** — handles Parquet loads (sorted scan) alongside Vortex loads (indexed lookup) in the same stitch
- O(matched rows) time — only reads what the predicate selects
- O(matched rows) memory for data buffers + O(output_rows × num_loads × 4B) for mapping vectors
- Ideal for point lookups and high-selectivity PK filters

See [Stage 2: IndexedStitcher](#stage-2-cross-family-stitch-read-time-partitionreader) for the full zero-copy algorithm and `MappedColumnVector` implementation.

**`SingleFamilyPassthrough`** — Optimization for single-load reads.

When column pruning determines only one load is needed, calls `reader.scan_data()` on that load and passes batches through directly, appending NULL arrays for absent columns. Zero-copy for the active load's columns.

### Stitcher selection

The `LattikScanBuilder` selects the stitcher based on the query and the capabilities of the involved loads:

| Condition | Stitcher |
|---|---|
| Only one load needed (column pruning) | `SingleFamilyPassthrough` |
| PK filter with high selectivity AND all loads have PK index | `IndexedStitcher` (fully zero-copy) |
| PK filter with high selectivity AND mixed load formats | `IndexedStitcher` (zero-copy for indexed loads, sorted scan for Parquet loads) |
| Full scan or low-selectivity filter | `NaiveStitcher` |

Override via Spark catalog config or query-time hint:
```sql
SELECT /*+ LATTIK_STITCHER('indexed') */ * FROM lattik.user_stats WHERE user_id = 42
```

## Catalog metadata

When a Gitea PR merges (webhook handler), the system:

1. Writes `s3://warehouse/lattik/<table_name>/manifests/v0000_init.json` with an empty columns map
2. Inserts a row into `lattik_table_commits` in Postgres: `(table_name='user_stats', manifest_version=0, manifest_load_id='init')`
3. Generates the Airflow DAG YAML (existing `dag-generator.ts` flow)

The `LattikCatalog` reads the latest manifest version from `lattik_table_commits` in Postgres, fetches the corresponding manifest from S3, and constructs a `LattikStitchedTable`. Schema information (`DESCRIBE TABLE`, `SHOW COLUMNS`) comes from the Lattik Table spec stored in the `definitions` table in Postgres — the catalog derives the stitched `StructType` from PK columns + family columns + derived columns. Time-travel queries resolve via Postgres (see [Time travel](#time-travel)).

**Rollback:** Insert a new commit row pointing to an old manifest version (see [Rollback](#rollback)). The commit log is append-only — rollback is recorded in the audit trail.

## Worked example: full query flow

**Setup:**

```yaml
name: user_stats
primary_key:
  - column: user_id
    dimension: user_id
column_families:
  - name: signups
    source: ingest.signups
    key_mapping: { user_id: user_id }
    columns:
      - name: home_country
        strategy: prepend_list
        expr: country
        max_length: 1            # most recent country = list[0]
  - name: purchases
    source: ingest.purchases
    key_mapping: { user_id: actor_id }
    columns:
      - name: lifetime_revenue
        strategy: lifetime_window
        agg: sum(amount)
      - name: purchase_count
        strategy: lifetime_window
        agg: count()
      - name: daily_purchase_activity
        strategy: bitmap_activity
        granularity: day
        window: 365
derived_columns:
  - name: avg_order_value
    expr: lifetime_revenue / purchase_count
```

**Batch write (Airflow DAG):**

```
build__user_stats (ds=2026-04-09, 00:00):
  1. Aggregate ingest.signups   → write load uuid-aaa to s3://.../loads/uuid-aaa/
  2. Aggregate ingest.purchases → write load uuid-bbb to s3://.../loads/uuid-bbb/
  3. Write manifest v0001_uuid-aaa.json:
     home_country → uuid-aaa
     lifetime_revenue, purchase_count, daily_purchase_activity → uuid-bbb
  4. Commit to Postgres (lattik_table_commits + lattik_column_loads)

build__user_stats (ds=2026-04-09, 06:00, incremental signups only):
  1. Aggregate ingest.signups delta → write load uuid-ccc to s3://.../loads/uuid-ccc/
  2. Write manifest v0002_uuid-ccc.json:
     home_country → uuid-ccc          ← updated
     lifetime_revenue, ... → uuid-bbb ← carried forward from v0001
  3. Commit to Postgres
```

After the batch jobs, S3 contains (bucket 10, shown as logical rows):

```
s3://warehouse/lattik/user_stats/loads/uuid-aaa/bucket=0010/
  data.vortex:       user_id=205 JP, user_id=100 US, user_id=317 DE     (unsorted)
  pk_index.vortex:   (100, row=1), (205, row=0), (317, row=2)           (sorted by PK)

s3://warehouse/lattik/user_stats/loads/uuid-bbb/bucket=0042/
  data.vortex:       user_id=317 80.0 3, user_id=442 20.0 1, user_id=100 500.0 12  (unsorted)
  pk_index.vortex:   (100, row=2), (317, row=0), (442, row=1)                       (sorted by PK)
```

**Query A — full scan (NaiveStitcher):**

```sql
SELECT * FROM lattik.user_stats
```

Uses latest snapshot. For bucket 42 (at the 128-bucket granularity):
- `home_country` → load uuid-ccc, bucket = 42 % 32 = 10
- `lifetime_revenue`, `purchase_count` → load uuid-bbb, bucket = 42

1. `NaiveStitcher` calls `scanData()` on both loads' bucket files — reads all rows sequentially
2. Builds `HashMap`: `{100: {uuid-ccc: (US), uuid-bbb: (500.0, 12)}, 205: {uuid-ccc: (JP)}, 317: {uuid-ccc: (DE), uuid-bbb: (80.0, 3)}, 442: {uuid-bbb: (20.0, 1)}}`
3. Emits stitched `ColumnarBatch`:

```
(100, US,   500.0, 12, 41.67)
(205, JP,   NULL,  NULL, NULL)     ← FULL OUTER: purchases side NULL
(317, DE,   80.0,  3,   26.67)
(442, NULL, 20.0,  1,   20.0)     ← FULL OUTER: signups side NULL
```

**Query B — point lookup (IndexedStitcher):**

```sql
SELECT user_id, home_country, avg_order_value
FROM lattik.user_stats
WHERE user_id = 100
```

Execution (using latest snapshot):
1. Resolve columns: `home_country` → uuid-ccc (32 buckets), `lifetime_revenue`+`purchase_count` → uuid-bbb (128 buckets)
2. `xxhash64(100) % 128` → bucket 42. Only one `StitchPartition`.
3. `IndexedStitcher` probes each load's `pk_index.vortex`:
   - uuid-ccc (bucket 42%32=10): zone maps → PK=100 → `row_id=1`
   - uuid-bbb (bucket 42): zone maps → PK=100 → `row_id=2`
4. Zero-copy random-access `data.vortex` via `MappedColumnVector`:
   - uuid-ccc row 1 → `{home_country: "US"}`
   - uuid-bbb row 2 → `{lifetime_revenue: 500.0, purchase_count: 12}`
5. Assemble + derived: `(100, "US", 500.0, 12, 41.67)`

Total I/O: two small index zone reads + two single-row random accesses. Sub-millisecond.

**Query C — wall-clock time travel:**

```sql
-- Spark
SELECT user_id, home_country
FROM lattik.default.user_stats TIMESTAMP AS OF '2026-04-09T03:00:00Z'
WHERE user_id = 100

-- Trino
SELECT user_id, home_country
FROM lattik.default.user_stats FOR TIMESTAMP AS OF TIMESTAMP '2026-04-09 03:00:00 UTC'
WHERE user_id = 100
```

Execution:
1. Query `lattik_table_commits WHERE committed_at <= 03:00` → manifest at 00:00
2. In that manifest: `home_country` → uuid-aaa (not uuid-ccc — the 06:00 load hadn't happened yet)
3. Read from uuid-aaa's files instead → gets the home_country as it was at midnight

**Query D — ETL time travel:**

```sql
-- Spark
SELECT user_id, home_country
FROM lattik.default.user_stats OPTIONS (ds '2026-04-01')
WHERE user_id = 100

-- Trino
SELECT user_id, home_country
FROM TABLE(lattik.system.user_stats_at(ds => DATE '2026-04-01'))
WHERE user_id = 100
```

Execution:
1. Query `lattik_column_loads WHERE ds = '2026-04-01'` → per-column load_ids for that ds
2. Fetch load.json for each load → stitch using the data as of that ETL date
3. Backfill results are reflected immediately — if ds=04-01 was re-run, the latest load for that ds is used

## Trino integration

The Trino integration is a thin Java wrapper over the same Rust core (`lattik-stitch-jni`) used by Spark. The stitch logic is identical — only the query engine API adaptation differs.

### Components

**`LattikConnectorFactory`** — implements Trino's `ConnectorFactory`

Creates a `LattikConnector` that reads manifests from Postgres + S3 (same as the Spark catalog).

**`LattikSplitManager`** — partition planning

Same logic as Spark's `planInputPartitions()`: resolve snapshot → map columns to loads → fetch `load.json` → plan bucket splits with power-of-2 alignment.

**`LattikPageSourceProvider`** — the read path

For each split, creates a `LattikPageSource` that delegates to the Rust core via JNI:

```java
class LattikPageSource implements ConnectorPageSource {
    private final long rustSession;  // JNI handle to Rust stitch session

    LattikPageSource(LattikSplit split, S3Config s3Config) {
        this.rustSession = LattikStitchJni.createSession(
            split.loadSpecs, split.pkColumns, split.stitcherId,
            split.pkFilter, s3Config
        );
    }

    @Override public Page getNextPage() {
        // Rust produces Arrow RecordBatch → C Data Interface → wrap as Trino Page
        ArrowBatch batch = LattikStitchJni.nextBatch(rustSession);
        if (batch == null) return null;
        return ArrowPageConverter.toPage(batch);
    }

    @Override public void close() {
        LattikStitchJni.closeSession(rustSession);
    }
}
```

The data flow is identical to Spark: S3 → Rust read buffers → Arrow C Data Interface → Trino `Page`/`Block` (zero-copy).

### Code sharing with Spark

| Component | Shared (Rust) | Spark-specific (Kotlin) | Trino-specific (Java) |
|---|---|---|---|
| File reading | `lattik-format-*` | — | — |
| Stitching | `lattik-stitch-core` | — | — |
| JNI bridge | `lattik-stitch-jni` | — | — |
| Catalog / manifest resolution | `lattik-stitch-core` | `LattikCatalog` | `LattikConnectorFactory` |
| Partition planning | `lattik-stitch-core` | `LattikBatch.planInputPartitions()` | `LattikSplitManager` |
| Row output | Arrow C Data Interface | `ArrowColumnVector` → `ColumnarBatch` | `ArrowPageConverter` → `Page` |

The Rust core is ~95% of the code. Each JVM wrapper is ~300 lines of API adaptation.

## Open questions

1. **~~`last()` semantics.~~** Resolved: `last()` is disabled. Use `max_by(col, event_timestamp)` or `min_by(col, event_timestamp)` for explicit ordering. The lattik-expression engine should not support `last()` / `first()` — they have ambiguous ordering semantics.

2. **~~Multi-column PK bucketing.~~** Resolved: hierarchical bucketing. Each PK column is hashed independently into its own bucket level (each a power of 2). Physical bucket = `level_1 * sub_count + level_2`. This enables shuffle-less cross-table joins on shared PK prefixes (e.g., a `[user_id, game_id]` table joining a `[user_id]` table on `user_id`). See [Hierarchical bucketing](#hierarchical-bucketing).

3. **~~Schema evolution.~~** Resolved by design. A new family writes a new load; the manifest adds columns pointing to it. Existing loads untouched. Columns can migrate between families — the next load writes the column data, the manifest updates the column→load mapping.

4. **~~Null PK values.~~** Resolved: NULL is treated as a valid PK value. Rows with NULL PKs hash to a deterministic bucket (e.g., `hash(NULL) = 0`) and participate in the stitch normally. Useful for anonymous sessions, system events, pre-registration activity. The hash function uses a consistent rule: `None → 0`.

5. **~~Table creation.~~** Resolved. The webhook handler writes the initial manifest and inserts into `lattik_table_commits` when the PR merges. Table is immediately visible in `LattikCatalog` (empty until the first batch run).

6. **~~Size estimation accuracy.~~** Resolved: post-write check + proactive split. After each write, the writer records actual bucket size stats in `load.json` (`min`, `max`, `median`, `p95`). If any bucket exceeds 2x `target_bucket_size`, the next run for this family doubles the relevant bucket level. No rewrite of the current load — the oversized bucket is tolerated for one cadence cycle. Self-corrects within one run.

7. **~~Atomicity of writes.~~** Resolved. Load files → UUID folder (immutable), manifest → S3 (immutable, filename includes load UUID), commit → Postgres INSERT (OCC via PK constraint). Crash before INSERT = orphaned files, cleaned by GC. Concurrent writers serialized by `UniqueViolation` on `(table_name, manifest_version)`.

8. **~~Retry and idempotency.~~** Resolved. Forward runs: idempotent via UPSERT on `lattik_column_loads`. Backfills: idempotent per ds — recomputes deltas and cascades cumulative. `ON CONFLICT DO UPDATE` prevents duplicates.

9. **~~Mixed cadences.~~** Resolved. For default/wall-clock queries, the latest manifest reflects whatever was last committed — hourly columns are fresher than daily, which is correct. For ETL time travel (`AS OF DS`), each column resolves to the latest available hour for that ds (or the specific hour if provided). Cumulative columns from different cadences are correctly handled — the resolution picks the most complete load per column for the requested ds. See [Time travel](#time-travel).

10. **~~Custom stitcher implementations.~~** Resolved. The `Stitcher` trait is intentionally minimal — future implementations are straightforward to add as new Rust structs. Candidates: `SortMergeStitcher` (for Parquet loads with sorted data, O(N) memory), windowed stitchers, approximate stitchers.

11. **~~PK index size.~~** Resolved. The index is small (~16 bytes/row for INT64 PK). Vortex compresses sorted integers extremely well (ALP/Frame-of-Reference). Auto-bucketing keeps bucket sizes bounded, so index sizes stay bounded too. The post-write size check (#6) catches oversized buckets.

12. **~~Retention and GC.~~** Resolved. GC targets: (a) old commit rows in Postgres beyond retention, (b) old column_loads rows beyond retention, (c) orphaned S3 files (manifests + load folders) not referenced by any retained commit. Runs after each batch job or on a separate schedule.

13. **~~Manifest version gap tolerance.~~** Resolved. The version number is derived from `max(manifest_version) + 1` in Postgres, not from S3. If a run writes `v0005_aaa.json` but crashes before the INSERT, the next run also targets v0005 (since Postgres still has max=4) and writes `v0005_bbb.json`. Both exist on S3 but only the committed one is referenced. GC deletes orphans.
