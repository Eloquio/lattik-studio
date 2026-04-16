# Plan: DuckDB Stitch-on-Read Extension

## Goal

Build a DuckDB extension that reads Lattik Tables directly from S3/MinIO by
performing stitch-on-read — the same column-family stitching that the Spark and
Trino connectors do today, but inside DuckDB. This gives Lattik Studio a
lightweight, embedded query path for interactive previews without requiring a
running Trino cluster.

## Context

Lattik Tables are stored as independent column-family load folders on S3. Each
load contains Parquet or Vortex files bucketed by primary key hash. A manifest
maps column names to load IDs. At query time a **stitcher** opens one reader per
load per bucket, joins them on primary key, and emits Arrow RecordBatches.

Today this stitching is exposed to Spark and Trino via a JNI bridge
(`lattik-stitch-jni`). The Rust core (`lattik-stitch-core`) is engine-agnostic —
it only needs a thin integration layer per query engine.

## Architecture

```
DuckDB Engine
  │  LOAD 'lattik_stitch_duckdb';
  │  SELECT * FROM lattik_scan('user_stats');
  │
  ▼
lattik_stitch_duckdb      (Rust — pure Rust DuckDB loadable extension)
  │  calls directly (no FFI)
  ▼
lattik-stitch-core + lattik-format-{parquet,vortex}
  │  reads
  ▼
S3 / MinIO
```

### Why Pure Rust (No FFI)

The `duckdb` Rust crate (with `loadable-extension` feature) lets us register
table functions directly from Rust and compile to a `.duckdb_extension` cdylib.
This follows the same pattern as Spark/Trino — pull the SDK as a dependency
rather than cloning the engine source. No C++ code, no FFI bridge, no CMake.

## New Crate

```
lattik-stitch/crates/
  lattik-stitch-core/          # existing — traits, stitchers, manifest, types
  lattik-format-parquet/       # existing — Parquet reader/writer
  lattik-format-vortex/        # existing — Vortex reader/writer
  lattik-stitch-jni/           # existing — Spark/Trino JNI bridge
  lattik-stitch-duckdb/        # NEW — DuckDB loadable extension (pure Rust)
```

## Detailed Design

### 1. `lattik-stitch-ffi` (Rust Crate)

A `cdylib` crate that exposes the stitch session lifecycle over C FFI. Mirrors
the JNI bridge but uses raw pointers and the Arrow C Data Interface directly.

#### Public C API

```c
// Create a stitch session from a JSON config (same schema as JNI).
// Returns an opaque handle. NULL on error (check lattik_last_error()).
LattikSession* lattik_session_create(const char* config_json);

// Export the output schema via Arrow C Data Interface.
// Caller owns the ArrowSchema and must release it.
int lattik_session_export_schema(LattikSession* session,
                                 ArrowSchema* out);

// Returns 1 if more batches are available, 0 if done.
int lattik_session_has_next(LattikSession* session);

// Export the next RecordBatch via Arrow C Data Interface.
// Populates out_schema and out_array. Returns 0 on success.
int lattik_session_next_batch(LattikSession* session,
                              ArrowSchema* out_schema,
                              ArrowArray* out_array);

// Close and deallocate the session.
void lattik_session_close(LattikSession* session);

// Return the last error message (thread-local). NULL if no error.
const char* lattik_last_error(void);
```

#### Session Config JSON

Same structure the JNI bridge already accepts:

```json
{
  "load_specs": [
    {
      "load_id": "uuid-a",
      "path": "s3://warehouse/lattik/user_stats/loads/uuid-a/bucket=0000/",
      "columns": ["lifetime_spending"],
      "pk_columns": ["user_id"],
      "format_id": "parquet",
      "sorted": true,
      "has_pk_index": false
    },
    {
      "load_id": "uuid-b",
      "path": "s3://warehouse/lattik/user_stats/loads/uuid-b/bucket=0000/",
      "columns": ["recent_purchases"],
      "pk_columns": ["user_id"],
      "format_id": "vortex",
      "sorted": false,
      "has_pk_index": true
    }
  ],
  "pk_columns": ["user_id"],
  "stitcher_id": "naive",
  "output_columns": [
    { "name": "user_id", "data_type": "int64" },
    { "name": "lifetime_spending", "data_type": "double" },
    { "name": "recent_purchases", "data_type": "string" }
  ],
  "pk_filter": {
    "filter_type": "in",
    "values": [1, 2, 3]
  },
  "s3_config": {
    "endpoint": "http://minio:9000",
    "region": "us-east-1",
    "bucket": "lattik-data",
    "access_key_id": "minioadmin",
    "secret_access_key": "minioadmin"
  }
}
```

#### Implementation Notes

- Wraps the existing `NaiveStitcher` / `IndexedStitcher` — no new stitching
  logic.
- Uses `arrow::ffi::{FFI_ArrowSchema, FFI_ArrowArray}` for zero-copy export.
- Thread-local error string via `std::cell::RefCell<Option<String>>`.
- `#[no_mangle] extern "C"` on all public functions.
- Links `lattik-stitch-core`, `lattik-format-parquet`, `lattik-format-vortex`
  as normal Rust dependencies.

### 2. `lattik-duckdb-extension` (C++)

A loadable DuckDB extension that registers the `lattik_scan` table function and
configuration settings.

#### SQL Interface

```sql
-- Load the extension
LOAD 'lattik_stitch';

-- Configure S3/MinIO connection (stored per DuckDB connection)
SET lattik_s3_endpoint   = 'http://minio:9000';
SET lattik_s3_region     = 'us-east-1';
SET lattik_s3_bucket     = 'lattik-data';
SET lattik_s3_access_key = 'minioadmin';
SET lattik_s3_secret_key = 'minioadmin';

-- Also configure the manifest base path
SET lattik_warehouse_path = 's3://lattik-data/warehouse/lattik';

-- Query a Lattik Table
SELECT user_id, lifetime_spending, recent_purchases
FROM lattik_scan('user_stats', version := 3)
WHERE user_id IN (1, 2, 3);

-- Omit version to read the latest manifest
SELECT * FROM lattik_scan('user_stats');
```

#### Table Function Lifecycle

DuckDB table functions follow a `bind` → `init` → `scan` lifecycle:

**Bind phase** — called once, resolves metadata:
1. Read table name and optional version from function arguments.
2. Fetch manifest JSON from S3:
   `{warehouse_path}/{table_name}/manifests/v{version}_*.json`
   (if no version, list manifests and pick the latest).
3. For each load_id in the manifest, fetch `load.json` to get format, bucket
   count, column list, and schema.
4. Build the output schema (PK columns + all requested columns).
5. Return cardinality estimate and column names to DuckDB.

**Init phase** — called per thread, partitions work:
1. Divide buckets across DuckDB threads. Each thread gets a range of bucket
   IDs.
2. Allocate thread-local state (no sessions created yet — lazy init on first
   scan call).

**Scan phase** — called repeatedly per thread, yields batches:
1. For the current bucket ID, build a session config JSON with `load_specs`
   scoped to that bucket.
2. Call `lattik_session_create(config)`.
3. If DuckDB pushed down a PK filter (equality or IN-list), include it as
   `pk_filter` and use `stitcher_id: "indexed"`. Otherwise use `"naive"`.
4. Loop `lattik_session_has_next()` / `lattik_session_next_batch()`.
5. Import Arrow arrays into DuckDB vectors via `ArrowToDuckDB`.
6. Advance to the next bucket, repeat.
7. Return empty when all assigned buckets are exhausted.

#### Filter Pushdown

DuckDB calls the table function's `filter_pushdown` callback with predicates.
The extension translates supported patterns to `PkFilter`:

| SQL predicate | PkFilter |
|---|---|
| `WHERE pk = 42` | `Eq(Int64(42))` |
| `WHERE pk IN (1, 2, 3)` | `In([Int64(1), Int64(2), Int64(3)])` |
| `WHERE pk BETWEEN 10 AND 100` | `Range { min: Int64(10), max: Int64(100) }` |

When a `PkFilter` is present and the load has a PK index (`has_pk_index: true`),
the extension switches to `IndexedStitcher` for 100x faster point lookups.

#### Projection Pushdown

DuckDB reports which columns the query actually needs. The extension only
includes those columns in `load_specs[].columns` and `output_columns`, so the
stitcher skips reading unused column families entirely.

#### Build

- Uses the DuckDB extension template
  (`https://github.com/duckdb/extension-template`).
- CMake build links against `liblattik_stitch_ffi.{so,dylib,dll}`.
- CI produces platform binaries: `linux_amd64`, `linux_arm64`, `osx_amd64`,
  `osx_arm64`.

### 3. Studio Integration

Once the extension is built, Studio can use it server-side via `duckdb-node`
(the Node.js binding for DuckDB) in Next.js API routes.

#### Server-Side Query Route

```typescript
// apps/web/src/app/api/query/duckdb/route.ts
import duckdb from 'duckdb-node-neo';

let db: duckdb.Database | null = null;

function getDb() {
  if (!db) {
    db = new duckdb.Database(':memory:');
    db.exec("LOAD 'lattik_stitch'");
    db.exec(`SET lattik_s3_endpoint   = '${process.env.MINIO_ENDPOINT}'`);
    db.exec(`SET lattik_s3_access_key = '${process.env.MINIO_ACCESS_KEY}'`);
    db.exec(`SET lattik_s3_secret_key = '${process.env.MINIO_SECRET_KEY}'`);
    db.exec(`SET lattik_s3_bucket     = '${process.env.MINIO_BUCKET}'`);
    db.exec(`SET lattik_warehouse_path = '${process.env.LATTIK_WAREHOUSE_PATH}'`);
  }
  return db;
}

export async function POST(req: Request) {
  const { sql } = await req.json();
  const result = getDb().all(sql);
  return Response.json({ rows: result });
}
```

#### Data Analyst Extension

The existing Data Analyst agent currently sends queries to Trino. With this
extension, it can route lightweight queries through DuckDB instead:

- **DuckDB path** — interactive previews, small result sets, ad-hoc exploration.
  No cluster required. Sub-second latency.
- **Trino path** — heavy analytical queries, joins across multiple Iceberg
  tables, production workloads. Requires the kind cluster.

The routing decision can be simple: use DuckDB by default, fall back to Trino
for queries that reference non-Lattik tables or exceed a row count threshold.

## Implementation Phases

### Phase 1: FFI Crate

- [ ] Create `lattik-stitch-ffi` crate with `crate-type = ["cdylib"]`
- [ ] Implement the 5 public C functions wrapping the existing session logic
- [ ] Generate C header via `cbindgen`
- [ ] Add integration tests: create session from JSON, iterate batches, verify
      Arrow output matches expected data
- [ ] Verify it compiles on macOS (aarch64) and Linux (x86_64)

### Phase 2: DuckDB Extension

- [ ] Fork the DuckDB extension template
- [ ] Register `lattik_scan` table function with bind/init/scan callbacks
- [ ] Implement manifest resolution in the bind phase (fetch from S3)
- [ ] Implement bucket-parallel scanning in the scan phase
- [ ] Add filter pushdown for PK predicates
- [ ] Add projection pushdown for column pruning
- [ ] Register `lattik_s3_*` and `lattik_warehouse_path` settings
- [ ] Test with DuckDB CLI against MinIO with sample Lattik Table data
- [ ] Package as loadable `.duckdb_extension`

### Phase 3: Studio Integration

- [ ] Add `duckdb-node-neo` dependency to `apps/web`
- [ ] Create `/api/query/duckdb` route with singleton DuckDB instance
- [ ] Wire the Data Analyst extension to use DuckDB for `lattik_scan` queries
- [ ] Add a toggle in Studio UI to switch between DuckDB and Trino
- [ ] Test end-to-end: chat → DuckDB query → result table in canvas

### Phase 4: Polish

- [ ] Error messages: surface `lattik_last_error()` through DuckDB's error
      reporting
- [ ] Progress reporting: emit DuckDB progress callbacks during long scans
- [ ] Auto-detect latest manifest version when `version` is omitted
- [ ] Add `lattik_tables()` table function to list available tables
- [ ] Documentation and README for the extension
- [ ] CI/CD: build matrix for platform binaries

## Open Questions

1. **Manifest resolution without Postgres** — The Spark/Trino connectors look up
   the latest manifest version from `lattik_table_commits` in Postgres. The
   DuckDB extension could either:
   - (a) List manifest files on S3 and pick the highest version number, or
   - (b) Accept a Postgres connection string and query the commit table, or
   - (c) Always require an explicit version.
   
   Option (a) is simplest for the Studio use case and avoids a Postgres
   dependency in the extension.

2. **Async runtime** — `lattik-stitch-core` uses Tokio for S3 I/O. The FFI
   layer needs to bridge sync C calls to async Rust. The JNI bridge solves this
   with a dedicated Tokio runtime per session. The FFI crate should do the same
   (`tokio::runtime::Runtime::new()` in `lattik_session_create`).

3. **Extension distribution** — DuckDB supports auto-installing extensions from
   a URL. Should we publish to a custom extension repository, or only distribute
   as a local file initially?

4. **Vortex dependency weight** — Vortex 0.68 pulls in a large dependency tree.
   If the initial use case only needs Parquet, the Vortex format could be a
   compile-time feature flag to keep the extension binary smaller.
