# Data Model: Entities, Dimensions, Metrics, Tables, and Cubes

> **Status:** This doc describes the **target model**. Some parts are not yet reflected in [`schema.ts`](../../apps/web/src/extensions/data-architect/schema.ts), the data-architect skill files, or the app UI. The "Schema gaps & follow-up renames" section at the end lists the concrete deltas other artifacts need to catch up to.

This doc is the cross-cutting view of how the six core Lattik pipeline concepts fit together. Each individual concept has its own skill file under [`apps/web/src/extensions/data-architect/skills/`](../../apps/web/src/extensions/data-architect/skills/); this doc is the place where their relationships are spelled out.

## TL;DR

Lattik separates a pipeline into a **logical layer** (Entities, Dimensions, Metrics) and a **physical layer** (Logger Tables, Lattik Tables, Cubes). The logical layer gives users canonical, FROM-less names to write expressions and queries against. The physical layer is where the data actually lives, and the query planner is responsible for picking the cheapest physical binding at query time.

```
┌──────────────── LOGICAL LAYER (canonical names, no FROM) ────────────────┐
│                                                                          │
│  Entity ──implicitly defines──▶ id Dimension                             │
│     ▲                              │                                     │
│     │ "is an attribute of"         │                                     │
│     │                              ▼                                     │
│  Dimension ◀── canonical name for an entity attribute                    │
│     ▲                                                                    │
│     │ "produces a value of"                                              │
│     │                                                                    │
│  Metric ◀── canonical name for an aggregation (or composition of others) │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                  ▲                          ▲
                  │ resolution binding       │ aggregation binding
                  │                          │
┌─────────────────┼──────────────────────────┼─────────────────────────────┐
│                 │   PHYSICAL LAYER         │                             │
│                 │                          │                             │
│           Lattik Table ◀──── source ──── Cube                            │
│                 ▲                          ▲                             │
│                 │ column_family            │                             │
│                 │ source                   │                             │
│                                                                          │
│           Logger Table ─────────────────── shortcut ─────────────────────▶ Cube
│                 │                                                        │
│                 │ semantic-equivalence tag                               │
│                 ▼                                                        │
│           Dimension (logical)                                            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram has two important features that the rest of the doc unpacks:

1. **The Dimension ↔ column relationship has two directions, and they mean different things.** The semantic-equivalence tag from a Logger Table column up to a Dimension is *provenance*, not a query-resolution path. The resolution binding from a Dimension down to a Lattik Table column is the actual *query target*. Conflating them is the most common mental-model mistake.
2. **Cubes are query-driven materializations, not user-defined wide tables.** A user declares a Cube as a query intent ("I want this set of dimensions × metrics × filters to be fast"), and the system picks the materialization shape and storage backend. Lattik Tables are user-defined wide tables that serve as the canonical denormalized layer.

## The six core concepts

### Entity

Defined in [defining-entity.md](../../apps/web/src/extensions/data-architect/skills/defining-entity.md). Schema: [`entitySchema`](../../apps/web/src/extensions/data-architect/schema.ts).

An **Entity** is a business concept that uniquely identifies something — `user`, `game`, `session`, `message`. It has:

- `name` — the entity's identifier (`user`)
- `id_field` — the column name used as its key. By convention `<entity>_id` (e.g. `user_id`), but any valid identifier is allowed — useful for external-system IDs (`stripe_customer_id`, `auth0_sub`), `uuid`, or shops with their own naming conventions.
- `id_type` — `int64` or `string`

Entities don't carry data themselves. They are the *vocabulary* the rest of the pipeline uses to talk about join keys and grain.

**Defining an Entity implicitly creates a Dimension** named after its `id_field`. Defining `user` with `id_field: user_id` is sufficient to make `user_id` exist as a Dimension whose entity is `user`. Role-playing variants like `sender_user_id` and `recipient_user_id` still need to be declared explicitly because they bind to different physical columns and carry different semantic roles.

### Logger Table

Defined in [defining-logger-table.md](../../apps/web/src/extensions/data-architect/skills/defining-logger-table.md). Schema: [`loggerTableSchema`](../../apps/web/src/extensions/data-architect/schema.ts).

A **Logger Table** is a raw, append-only event stream — narrow rows representing event occurrences, partitioned by `ds` and `hour`, with implicit `event_id` / `event_timestamp` columns. Each user-defined column may carry one or more **semantic-equivalence tags** (currently a single field called `dimension`, see gap list) that say "this physical column carries the same meaning as this Dimension."

Logger Tables are the **input** layer to the pipeline. They are not normally read directly to answer business queries — orgs typically configure cost or scan-size policies that limit ad-hoc Logger Table aggregation, and Lattik Tables / Cubes exist precisely to make those queries cheap.

Applications send events to Logger Tables via `@eloquio/lattik-logger`. The SDK serializes each event into a Protobuf **Envelope** (`table`, `event_id`, `event_timestamp`, opaque `payload` bytes) and POSTs it to the ingestion service ([`apps/ingest/`](../../apps/ingest/)), a Go HTTP server that deduplicates by `event_id` (in-memory TTL cache, default 1h window) and produces the envelope to the per-table Kafka topic. When a Logger Table definition is merged, the Gitea webhook automatically creates the Kafka topic and registers the per-table Protobuf payload schema in the Confluent Schema Registry.

### Lattik Table

Defined in [defining-lattik-table.md](../../apps/web/src/extensions/data-architect/skills/defining-lattik-table.md). Schema: [`lattikTableSchema`](../../apps/web/src/extensions/data-architect/schema.ts).

A **Lattik Table** is a super-wide, denormalized table at a fixed granularity level. The grain is defined by its `primary_key`s, a list of `{column, dimension}` pairs where each `dimension` reference is the canonical Dimension that the corresponding PK column carries — typically the implicit id Dimension of an Entity (`user_id` from the `user` entity). The Dimension's own `entity` field carries the entity transitively, so the system can answer "what entity is this table keyed on" without the PK referencing the entity directly.

A Lattik Table with `primary_key: [{column: user_id, dimension: user_id}]` is a per-user wide table. Multi-entity grains like `[{column: user_id, dimension: user_id}, {column: product_id, dimension: product_id}]` are also valid (one row per (user, product)). **Time is never a PK component.** A Lattik Table is the *current state* at a chosen point in time; the time axis enters queries via Iceberg-style **as-of semantics** (see [Time semantics](#time-semantics)), not via per-day or per-hour PK columns.

Lattik Tables are built from `column_families`, each of which declares a `source` (Logger or Lattik table), a `key_mapping` from this table's PK columns to the source's columns, an optional `load_cadence` (`daily` or `hourly`, inferred from the source if omitted), and a list of columns. Each column declares a **strategy** that defines how source events are aggregated and how the result is stored:

- `strategy: lifetime_window, agg: sum(amount)` — scalar aggregation over all source events (cumulative lifetime sum)
- `strategy: prepend_list, expr: country, max_length: 1` — bounded ordered list of recent values (most recent country = `list[0]`)
- `strategy: bitmap_activity, granularity: day, window: 365` — bitfield tracking entity activity per time slot (DAU/streaks/churn)

Cadence, strategy, and PK are three independent dials. None of them put time in the data model.

Lattik Tables are the **canonical denormalized layer**: the place where "everything we know about a user" (or any other entity grain) lives. They serve two roles:

1. **Resolution-binding host.** Every Dimension's resolution binding (where the planner reads its value at query time) lives on a Lattik Table at the appropriate entity grain. Without a Lattik Table at user grain, no `user`-entity Dimensions are queryable.
2. **Aggregation source.** Metric aggregation expressions can target Lattik Tables (or Logger Tables, but Lattik Tables are usually preferred because they are pre-rolled).

In ML / warehousing terms, a Lattik Table is essentially a **feature store entity table**, or a **Kimball conformed dimension** with as-of time-travel built in (Type 2 SCD semantics achieved via the storage layer rather than via dated PK rows).

### Dimension

Defined in [defining-dimension.md](../../apps/web/src/extensions/data-architect/skills/defining-dimension.md). Schema: [`dimensionSchema`](../../apps/web/src/extensions/data-architect/schema.ts).

A **Dimension** is a canonical name for an attribute of an Entity. The point of a Dimension is **to let users write expressions and queries that reference the attribute by name without specifying a FROM clause**. Because the name is canonical, the query planner can resolve where to read it.

A Dimension declaration carries:

- `name` — canonical identifier (`user_home_country`)
- `entity` — which Entity this attribute belongs to (`user`)
- `data_type` — column type
- `resolution_bindings` — one or more `{table, column}` pairs telling the planner where the value can be read at query time. Bindings always live on Lattik Tables at the appropriate entity grain.

Dimensions divide cleanly into two flavors:

- **id-style Dimensions** like `user_id`, `sender_user_id`, `recipient_user_id`. The dimension's "value" is an entity id. The resolution binding is the user-grain Lattik Table's id column — and crucially, role-playing variants like `sender_user_id` and `user_id` *share* the same resolution binding location. They are distinguished only by their semantic-equivalence tags on source tables (see [Role-playing dimensions](#role-playing-dimensions)).
- **attribute-style Dimensions** like `user_home_country`, `user_invoice_country`. The resolution binding is a non-id column on a Lattik Table at the entity's grain.

The id-style implicit Dimension created by an Entity definition is just the special case where the entity binding is "the table whose grain is this entity, column = the entity's id_field."

### Metric

Defined in [defining-metric.md](../../apps/web/src/extensions/data-architect/skills/defining-metric.md). Schema: [`metricSchema`](../../apps/web/src/extensions/data-architect/schema.ts).

A **Metric** is a canonical name for an aggregation, designed to compose with Dimensions in queries. As with Dimensions, the point is canonical naming: users write `revenue × user_home_country` and the planner resolves both sides.

A Metric has one or more **calculations**, of two flavors:

- **Aggregation calculations** — bind to a Lattik or Logger Table and aggregate columns on it. By convention, column names on Lattik Tables match the canonical Dimension names they represent, so an aggregation expression like `sum(purchase_amount)` reads identically whether you think of it physically or canonically.
- **Row-level calculations** — compose other Metrics by name (no FROM, no source table). For example, `revenue_per_user = revenue / user_count`.

Multiple calculations on the same Metric express the same canonical concept against different physical sources. `daily_active_users` might have one calculation that aggregates a `user_attributes` Lattik Table (`count_if(is_dau)`) and another that scans a Logger Table (`count_distinct(user_id)`). The planner picks at query time.

### Cube

A **Cube** is a user declaration of *query intent* that the system uses to drive a pre-materialization pipeline. The user says "I want `(d1, d2, d3) × (m1, m2)` filtered by `country = 'US'` to be fast," and the system picks both the materialization shape and the storage backend (Iceberg table, Druid segment, etc.) based on the cost and latency targets.

A Cube is *not* a hand-shaped wide table. Lattik Tables already fill that role. A Cube is the place where the user expresses a workload-driven optimization without committing to its physical shape.

Cubes can source directly from Logger Tables (a shortcut path) or build on top of existing Lattik Tables. Either way, a successful Cube produces a routing target the query planner can prefer when an incoming query matches the Cube's shape.

> **Naming clash with Cube.dev:** "Cube" in Lattik means *workload-driven materialization*. "Cube" in Cube.dev means *logical model of a fact source* (closer to a Lattik Table than to a Lattik Cube). When this doc references the product, it always says **Cube.dev**. When it references the Lattik concept, it says **Cube** or **Lattik Cube**. The ambiguity is unavoidable in conversation but should be policed in code and UI.

## The two relationships: tag vs binding

The single most important distinction in the data model is that there are **two different relationships** between a Dimension and a column, and they look superficially similar but mean very different things.

### Semantic-equivalence tag (column → Dimension, source-side)

A semantic-equivalence tag lives on a column of a Logger Table (and potentially also on Lattik Table columns) and says: *"This physical column carries the same meaning as this Dimension."*

- **Direction:** column → Dimension
- **Lives on:** raw or intermediate physical columns
- **Cardinality:** many columns can be tagged with one Dimension; one column may carry multiple tags
- **Used for:** lineage and provenance, ETL/derivation rules, materialization input ("when you build a user-grain Lattik Table, you can roll `signups.country` up into `user_home_country`")
- **NOT used for:** query resolution

A semantic-equivalence tag is a **declaration about what a column means**. It does not, on its own, make the column a queryable source for the dimension.

**Example of multi-tagging.** A `payments` logger table has a `country` column recording where each payment originated. The same physical column legitimately serves as the upstream source for two different Dimensions on two different Entities:

```yaml
- name: payments
  columns:
    - name: country
      type: string
      semantic_equivalence:
        - payment_country        # dimension on the `payment` entity
        - user_billing_country   # dimension on the `user` entity
```

- `payment_country` is a per-transaction attribute. It resolves on a payment-grain Lattik Table where each row is one payment.
- `user_billing_country` is a user-level attribute. It resolves on a user-grain Lattik Table where the column is materialized as `max_by(country, event_timestamp)` — the most recent billing country across all of a user's payments.

Both tags are correct for every row at write time: the country a payment came from *is*, by definition for that row, the user's most recent billing country. The fact that a user's billing country can drift over time doesn't break the example — that drift is handled at the Lattik Table layer via the `last(...)` aggregation, not at the tag layer. The tag is purely the declaration *"this column is a valid upstream source for that Dimension."*

### Resolution binding (Dimension → table+column, query-side)

A resolution binding lives on the Dimension and says: *"To read this dimension's value at query time, read it from here."*

- **Direction:** Dimension → table+column
- **Lives on:** the Dimension declaration
- **Cardinality:** one Dimension can have multiple resolution bindings (across multiple Lattik Tables)
- **Hosted on:** Lattik Tables at the appropriate entity grain (Cubes are an additional routing tier the planner consults, but the user-facing canonical model places resolution bindings on Lattik Tables)
- **Used for:** query routing — when a query mentions `user_home_country`, the planner picks one of the resolution bindings as the read source

The resolution binding is **how a query gets answered**. Without one, the dimension is "registered" but unqueryable.

### Why both, and how they keep each other honest

At first glance the two relationships look like two views of one fact, but they serve different purposes and live at different layers:

- The **tag** is an *input declaration* used to build pipelines, validate lineage, and reason about provenance.
- The **binding** is an *output declaration* used to route queries.

The two are kept consistent by validation: when a Lattik Table's column family pulls from `signups.country` and rolls it up into a `home_country` column, the system can verify that the source column is tagged with `user_home_country` and that the resulting Lattik Table column matches the Dimension's resolution binding. If a column on a logger table is tagged with a Dimension that no Lattik Table ever reads from, the user will eventually be told "this tag is dangling — define a Lattik Table column that resolves it, or remove the tag."

### Worked example of the distinction

Suppose the `signups` Logger Table has a column called `country` tagged as `user_home_country`. **That tag does not make `signups` a query source for `user_home_country`.** It only declares the semantic equivalence so that downstream pipelines can roll it up.

The actual resolution binding for `user_home_country` lives on a Lattik Table — say, `user_attributes` at grain `[user]`, with a column called `home_country`. When a user writes `revenue × user_home_country`, the planner reads `user_attributes.home_country`, not `signups.country`. The `signups` tag is the *upstream provenance* of the `user_attributes.home_country` column, but it is not where the query is answered.

If the user writes a query that references `user_home_country` and *no* Lattik Table has a resolution binding for it, the right system response is to refuse the query and tell the user "no resolution binding exists; build a user-grain Lattik Table that contains this dimension, or define a Cube."

## Query routing

### How the planner picks bindings

The query planner sees a logical query — a set of Dimensions, a set of Metrics, optional filters — and must turn it into physical SQL. Its job is to **pick the cheapest binding combination that covers the query** from among the available physical sources:

- Resolution bindings on Lattik Tables (the canonical case)
- Cube outputs (when one matches the query shape)
- Logger Table aggregations (typically permitted only within an org-configured cost budget)

When multiple Dimensions and Metrics are involved, the planner tries to find a single physical table that hosts bindings for all of them at a compatible grain. If no single table covers the query, it must fall back to a join or refuse the query.

### Logger × Logger queries are refused

The planner does **not** join two Logger Tables on an entity to satisfy a query. The semantic-equivalence tags on logger columns are not resolution bindings — they cannot be used as read sources directly. If a query needs `revenue` (currently only on a `purchases` Logger Table) and `user_home_country` (currently only tagged on a `signups` Logger Table column), the right system response is: "no resolution path. Define a user-grain Lattik Table that contains both, or define a Cube that materializes this query."

This is intentional. Joining two raw event streams across an entity is exactly the kind of expensive scan the Lattik Table / Cube layers exist to prevent.

### Logger × Lattik and Lattik × Lattik

When at least one side of a query is on a Lattik Table at the right entity grain, the planner can do the join in a star-schema lookup style. The join key is determined by the entity binding on each side: a Lattik Table at grain `[user]` with `user_id` as its primary key, joined to a fact source whose join column is tagged with a `user`-entity Dimension.

The cleanest case is when both sides live on the same Lattik Table at the same grain — no join needed at all. The presence of a single wide Lattik Table that hosts both a Metric's aggregation source and the relevant Dimensions is the ideal.

### Role-playing dimensions

`sender_user_id` and `recipient_user_id` are both Dimensions whose entity is `user`. Their **resolution binding is the same**: both point at the user-grain Lattik Table. What distinguishes them is which physical columns carry their **semantic-equivalence tags**:

- `user_id`'s tag lives on canonical user-key columns across many tables (`purchases.user_id`, `auth.user_id`, etc.)
- `sender_user_id`'s tag lives specifically on `messages.sender_user_id`
- `recipient_user_id`'s tag lives on `messages.recipient_user_id`

When the planner sees `count(messages) × sender_user_id × user_home_country`:

1. It identifies `sender_user_id`'s source-side anchor as `messages.sender_user_id`.
2. It joins `messages.sender_user_id = user_grain_table.user_id`.
3. It reads `user_home_country` from `user_grain_table.home_country`.

So role-playing is a **source-side disambiguation mechanism**. Multiple Dimensions can share one resolution binding while owning disjoint sets of source-side tags. This preserves the invariant that "every binding lives on a Lattik Table at entity grain" while still letting the user write `sender_user_id` vs `recipient_user_id` as semantically distinct names in queries.

### Where Cubes fit in routing

When a Cube exists for a query shape that subsumes the incoming query, the planner prefers the Cube. Cubes can be seen as additional resolution-binding tiers that the system created on the user's behalf, materialized at whatever storage backend gives the right cost/latency profile.

The full routing preference order is roughly: **Cube > Lattik Table > Logger Table (if policy allows) > refuse**.

### Time semantics

The three table types treat time differently. The doc spells out the Lattik Table case in full; Logger Table and Cube time semantics are deferred and need their own design pass.

| Table type | How time works | Status |
|---|---|---|
| **Lattik Table** | Iceberg-style **as-of** semantics. Time is not in the data model, not in the PK, not a Dimension. Queries name an as-of timestamp (default = "now") and the storage layer returns the snapshot of the table that was current at that point. Snapshot vs cumulative is a per-column property. The load cadence (`daily`/`hourly` on each column family) controls how often new snapshots are produced. | Designed |
| **Logger Table** | Append-only, partitioned by `ds`/`hour`. Logger queries do not use as-of — the time axis is the *natural axis* of the data. Queries against logger sources need to express a time range explicitly. | TBD — see gap list |
| **Cube** | A Cube is a precomputed result for a specific workload shape. Time semantics depend on what the Cube was materialized for, and the rules for how an incoming as-of query gets routed to a Cube are not yet designed. | TBD — see gap list |

The key invariant for the Lattik layer: **time-travel happens at query time, not at modeling time**. Users do not declare `ds` or `hour` in PKs and do not create per-day Lattik Tables. If you want "revenue on 2026-04-01," you query the existing entity-grain `lattik.user_revenue` as-of `2026-04-01`. If you want "revenue every day for the last 30 days," that's a Cube workload, not a Lattik Table modeling decision.

## Worked example: end to end

Suppose the goal is "as of 2026-04-01, total revenue per user home country, for US users."

**Entities:**

```yaml
- name: user
  id_field: user_id
  id_type: int64
```

Defining `user` implicitly creates a Dimension `user_id` whose entity is `user`. There is no `date` entity — time is not in the logical layer.

**Logger Tables (raw input):**

```yaml
- name: ingest.purchases
  columns:
    - name: actor_id        # raw column name from the producer
      type: int64
      semantic_equivalence: [user_id]    # tag: this is the user join key
    - name: amount
      type: double
      semantic_equivalence: [purchase_amount]
    - name: country
      type: string
      semantic_equivalence: [purchase_country]
- name: ingest.signups
  columns:
    - name: user_id
      type: int64
      semantic_equivalence: [user_id]
    - name: country
      type: string
      semantic_equivalence: [user_home_country]  # tag, NOT a resolution binding
```

**Dimensions (logical):**

```yaml
- name: user_id           # implicitly created by `user` entity
  entity: user
  data_type: int64
  resolution_bindings:
    - table: lattik.user_attributes
      column: user_id
    - table: lattik.user_revenue
      column: user_id
- name: user_home_country
  entity: user
  data_type: string
  resolution_bindings:
    - table: lattik.user_attributes
      column: home_country
```

**Metric (logical):**

```yaml
- name: revenue
  calculations:
    - kind: aggregation
      expression: sum(amount)
      source_table: ingest.purchases
    - kind: aggregation
      expression: sum(lifetime_revenue)
      source_table: lattik.user_revenue
```

**Lattik Tables (physical resolution targets):**

```yaml
- name: lattik.user_attributes      # entity-grain: one row per user
  primary_key:
    - column: user_id
      dimension: user_id
  column_families:
    - name: home
      source: ingest.signups
      load_cadence: daily            # optional; would be inferred from source if omitted
      key_mapping: { user_id: user_id }
      columns:
        - name: home_country
          strategy: prepend_list
          expr: country
          max_length: 1              # most recent country = list[0]

- name: lattik.user_revenue         # entity-grain: one row per user
  primary_key:
    - column: user_id
      dimension: user_id
  column_families:
    - name: revenue
      source: ingest.purchases
      load_cadence: hourly
      key_mapping: { user_id: actor_id }
      columns:
        - name: lifetime_revenue
          strategy: lifetime_window
          agg: sum(amount)           # cumulative — each load adds to the prior value
```

Note that `lattik.user_revenue` has PK `[user_id]`, *not* `[user_id, ds]`. There's one row per user. The `lifetime_revenue` column uses the `lifetime_window` strategy with `sum(amount)`, so at any as-of timestamp it gives you "total revenue accumulated up to that point." The hourly load cadence determines how frequently the value refreshes; the table itself remains entity-grain.

**The query** *"as of `2026-04-01`, give me `revenue × user_home_country` filtered to `user_home_country = 'US'`"* is answered as follows:

1. The planner sees that `revenue` has bindings on both `ingest.purchases` (Logger) and `lattik.user_revenue` (Lattik). It prefers the Lattik binding.
2. It sees that `user_home_country` has a binding on `lattik.user_attributes`. The `ingest.signups` tag is *not* a candidate.
3. Both Lattik Tables are at user grain, so the join is a star-schema lookup on `user_id`. The query opens both tables **as of `2026-04-01`** — Iceberg time-travel reads the snapshot of each table that was current on that date.
4. It applies the `home_country = 'US'` filter on `lattik.user_attributes.home_country` (as of the same timestamp).
5. It groups by `home_country` and sums `lifetime_revenue`.

If the user wants this query to be even faster — or wants a result that *isn't* tied to an as-of point and instead reflects, say, "month-end revenue for each of the last 12 months" — they can declare a **Cube** with the appropriate intent. The system will materialize a precomputed table on the right backend, and the planner will route subsequent matching queries to it directly. (How time semantics work inside a Cube is covered separately — see the [Time semantics](#time-semantics) section.)

## Comparison with semantic layers

Lattik's data model overlaps significantly with Cube.dev, dbt Semantic Layer (MetricFlow), LookML, and Malloy, but differs in two structural ways:

1. **The logical layer is independent of any single fact source.** A Dimension is owned by an Entity, not by a "cube" or "view" or "semantic model." Multiple physical tables can carry it. The other tools mostly scope dimensions inside one logical container at a time.
2. **There is a first-class workload-driven materialization layer (Cubes) that the system shapes.** No other tool treats "I want this query shape to be fast" as a top-level user-facing concept that maps onto an automatically-generated pipeline and a chosen storage backend.

### Concept-by-concept mapping

| Lattik | Cube.dev | dbt Semantic Layer (MetricFlow) | LookML | Malloy |
|---|---|---|---|---|
| **Entity** | (no first-class concept; primary keys live inside cubes) | `entity` (first-class, with type `primary` / `foreign` / `natural`) | (no first-class concept; join keys are inferred from explore joins) | (sources have primary key fields; no separate entity concept) |
| **Dimension** | `dimension` (scoped to one cube) | `dimension` (scoped to one semantic model) | `dimension` (scoped to one view) | `dimension` (scoped to one source) |
| **Multi-binding Dimension** | partial — via cube `joins` and pre-aggregations | partial — "linkable elements" can be referenced across semantic models via entities | partial — extending a base view | partial — extending a source |
| **Metric (aggregation calculation)** | `measure` | `measure` (inside a semantic model) → `simple metric` | `measure` | `measure` |
| **Metric (row-level composition)** | `calculated measure` (via SQL string referencing other measures) | `derived metric`, `ratio metric`, `cumulative metric` | derived `measure` using `${...}` references | derived measure as expression |
| **Logger Table** | typically a `cube` with `sql_table` | a `semantic_model` with `model: ref('logs')` | a `view` over a base table | a `source: from(...)` |
| **Lattik Table (canonical wide entity table)** | can be modeled as a separate `cube` joined in | a separate `semantic_model` linked via `entity` | a separate `view` joined in an explore | a separate `source` extending or joining |
| **Cube (workload-driven materialization)** | `pre_aggregations` block (closest analog, but scoped inside a cube and requires the user to declare the rollup shape) | no direct equivalent (caching at the query layer, no rollup routing) | `aggregate_awareness` + persistent derived tables (manual; user picks the rollups) | no direct equivalent |
| **Semantic-equivalence tag (column → Dimension)** | implicit (the column *is* the dimension; no separate tag) | implicit | implicit | implicit |
| **Resolution binding** | implicit (each dimension is anchored to its containing cube's `sql_table`) | implicit (each dimension is anchored to its containing semantic model) | implicit | implicit |
| **Query planner picks among bindings** | yes for pre-aggregations (matches an incoming query to a rollup) | no (compiles to one SQL plan against one model graph) | partial (aggregate awareness picks among PDTs) | no |
| **Time-travel as a query primitive** | no (time is a column on the fact table, typically `created_at` / `event_date`) | no (time is a `time_dimension` on the semantic model) | no (time is a column you `dimension_group` on) | no (time is a column) |

The dimmer cells in the right four columns are essentially the gaps Lattik aims to close.

### Quick gap analysis (Lattik vs the field)

**What Lattik has that the others don't (or only partially have):**

- **A canonical, source-independent logical layer.** A Dimension lives above any one physical table. The other tools require you to anchor every dimension inside a single cube/view/semantic model and then *join* across containers. This matters because conformed dimensions (the same `user_home_country` referenced from many physical sources) are first-class in Lattik and bolted-on in the others.
- **The two-relationships split (tag vs binding).** No other tool explicitly separates "this column means the same thing as this dimension" from "this is where queries should read this dimension." In Cube.dev/LookML/MetricFlow/Malloy, defining a dimension *is* declaring its read source — the two are conflated. Lattik's split lets the same dimension exist in many physical places (provenance) while still routing queries to one canonical materialized location.
- **Workload-driven Cubes.** A first-class user concept where the user expresses query intent and the system picks the materialization shape and storage backend. Cube.dev's `pre_aggregations` is the closest analog and is meaningfully less abstract — the user still has to declare the rollup keys and granularity. No other tool offers this.
- **Heterogeneous storage backends behind one logical layer.** Cubes can land on Iceberg, Druid, or other backends depending on the cost/latency profile. Cube.dev is single-backend per deployment, MetricFlow is single-warehouse, LookML is single-database, Malloy is single-database.
- **As-of time-travel as a query primitive.** Lattik Tables are queried with an as-of timestamp; the storage layer returns the snapshot current at that point, with no `ds`/`hour` columns in the data model. The other tools require time to be modeled as a column on the fact table and joined/grouped explicitly. Lattik's approach avoids the "time everywhere in the schema" tax for the common "as of date X" use case.

**What the others have that Lattik doesn't (or doesn't yet):**

- **Polished IDE / authoring experience.** LookML in particular has years of investment in dev ergonomics. Cube.dev has a strong developer UI. Lattik's data-architect canvas workflow is the analog and is still maturing.
- **A query language for ad-hoc consumption.** Malloy in particular is built around an expressive query language; LookML has explores; Cube.dev exposes a JSON query API. Lattik has lattik-expression for definitions but the user-facing query interface is still an open question.
- **Mature semantic-layer integrations.** dbt Semantic Layer integrates with downstream BI tools via a metric API. Cube.dev exposes REST/SQL/GraphQL endpoints. Lattik would need similar surfaces for these dimensions and metrics to be consumed by external tools.
- **Time-grain modeling for metrics.** MetricFlow has first-class `time_dimension` and cumulative/rolling/window metric types. LookML has measure filters and time granularities baked in. Lattik's answer to "give me 7-day rolling DAU" routes through the Cube layer (workload-driven materialization) rather than through fact-table column conventions, which is more powerful but requires the user to declare the workload up front rather than ad-hoc.
- **Joins as first-class config.** LookML explores and Cube.dev cube `joins` make join paths an explicit declared object. Lattik infers joins from entity bindings, which is cleaner when it works but offers less control when the user needs to override.

### Where Lattik is most differentiated

The combination that no other tool offers is **(1) a logical layer that is independent of any one fact source + (2) workload-driven Cubes that materialize on heterogeneous backends**. Either alone exists in the field; the combination is the architectural bet.

The closest neighbors:

- **dbt MetricFlow** is closest on the logical layer (entities + semantic models + linkable dimensions), and weakest on materialization (no pre-aggregation routing at all).
- **Cube.dev** is closest on materialization (pre-aggregations are real), and weakest on the logical layer (every dimension is scoped to one cube).
- **LookML** is closest on operational maturity, weakest on conceptual cleanliness (everything is a view, joins are explicit, conformed dimensions require base-view inheritance).
- **Malloy** is closest on expressive query language, weakest on materialization and operational tooling.

## Schema gaps & follow-up renames

This doc describes the target model. Several pieces of the existing implementation need to catch up. Each gap below is a separate follow-up — I have not modified any of these files.

### Schema gaps in [`schema.ts`](../../apps/web/src/extensions/data-architect/schema.ts)

1. **Dimension single binding → multi-binding.** `dimensionSchema` currently has `source_table: string` and `source_column: string`. This needs to become `resolution_bindings: Array<{table, column}>` to support the conformed-dimension pattern.
2. **Logger column tag rename and arity.** `loggerColumnSchema.dimension: string` should be renamed `semantic_equivalence` (or `tags`) and probably allowed to be an array — a single column may carry multiple tags.
3. **Implicit entity dimension.** Defining an Entity should automatically register a Dimension named after its `id_field`, with the entity binding pre-set. The schema does not currently express this; it could be done either by validation pass or by generating the implicit Dimension during YAML expansion.
4. **Metric row-level composition.** `metricCalculationSchema` currently only supports `{expression, source_table}` (aggregation against a physical table). A second flavor — row-level composition over other Metrics, with no `source_table` — needs to be added. Suggested shape: a discriminated union with `kind: "aggregation" | "composition"`.
5. **Cube definition.** No `cubeSchema` exists yet. A Cube needs at minimum: `name`, `dimensions: string[]`, `metrics: string[]`, `filters?: ...`, `latency_target?`, `cost_target?`, optional `materialization_hint`. The system uses these to generate the materialization pipeline.
6. **Lattik Table column-level semantic-equivalence tags.** Lattik Table columns may also carry tags (especially for the convention "column name = Dimension name" — a tag would make this explicit). `familyColumnSchema` and `derivedColumnSchema` should allow an optional `semantic_equivalence` field.
7. **Lattik Table primary_key reference change.** `primaryKeySchema` currently has `{column, entity}`. This should become `{column, dimension}` so that the PK reference points at the canonical entity-id Dimension (the implicit id Dimension created by the Entity). The Dimension's own `entity` field carries the entity transitively, so no information is lost. This unifies the model: every reference to a logical concept goes through a Dimension name, never directly through an Entity name. **PKs reference entity Dimensions only — never time Dimensions like `ds`/`hour`** (time is not in the data model; see gap #9).
8. **Column family load cadence.** `columnFamilySchema` should gain an optional `load_cadence: "daily" | "hourly"` field. When omitted, it is inferred from the source (specific inference rule TBD — likely "inherit from source if source is a Lattik Table, otherwise default to a system-wide value"). Multiple column families on the same Lattik Table may declare different cadences; querying such a table requires the user to be deliberate about as-of granularity.
9. **As-of query primitive on Lattik Tables.** Time is not in the data model. Lattik Tables are queried with an as-of timestamp; the storage layer (Iceberg) returns the snapshot current at that point. The schema does not need a field for this — it lives at the query API. But there should be no PK column for `ds`/`hour` and no `date` entity. **Migration:** any existing pipelines that put `ds` or `hour` in a Lattik Table PK need to be flagged and migrated to entity-grain. Validation should refuse new Lattik Table definitions whose PK references a time-shaped column.
10. **Logger Table time semantics — design TBD.** Logger Tables don't use as-of; they use time ranges over their physical `ds`/`hour` partitions. The query interface for "give me a Metric whose only binding is a Logger Table" needs a design pass: how the user expresses the time range, how the org-configured cost guards interact with it, and whether `event_timestamp` or `ds`/`hour` is the canonical filter axis.
11. **Cube time semantics — design TBD.** A Cube is a precomputed result for a workload shape. The rules for how an as-of query on a Lattik Table can be routed to a Cube, and how a Cube declares the time range it covers, need a design pass. Until designed, the planner cannot use Cubes to satisfy time-aware queries.

### Skill doc updates

12. [defining-entity.md](../../apps/web/src/extensions/data-architect/skills/defining-entity.md) should mention the implicit Dimension created from `id_field`.
13. [defining-entity.md](../../apps/web/src/extensions/data-architect/skills/defining-entity.md) should also relax the `id_field` suffix rule from "must end with `_id`" to "by convention ends with `_id`, but any valid identifier is allowed." Real-world cases this unblocks: `uuid`, external-system IDs (`stripe_customer_id`, `auth0_sub`), and shops with their own naming conventions. If [validation/naming.ts](../../apps/web/src/extensions/data-architect/validation/naming.ts) ever picks up this rule, it should match.
14. [defining-dimension.md](../../apps/web/src/extensions/data-architect/skills/defining-dimension.md) should be rewritten around the **two-relationships** framing — currently it conflates "dimension lives at this column" (sounds like a tag) with "dimension is read from this column" (the binding). The skill should also describe the multi-binding case and when to add a new binding vs declare a new Dimension.
15. [defining-logger-table.md](../../apps/web/src/extensions/data-architect/skills/defining-logger-table.md) should rename `dimension` (the optional column field) to `semantic_equivalence` and explain that it is a *tag*, not a query source.
16. [defining-lattik-table.md](../../apps/web/src/extensions/data-architect/skills/defining-lattik-table.md) needs three updates: (a) describe `primary_key` entries as `{column, dimension}` rather than `{column, entity}`, (b) explicitly state that PKs are entity-grain only — no `ds`/`hour`, no time-bucketed Lattik Tables — and explain that time-travel happens at query time via as-of, (c) document the new `load_cadence` field on column families.
17. [defining-metric.md](../../apps/web/src/extensions/data-architect/skills/defining-metric.md) should describe the row-level composition flavor in addition to aggregation.
18. A new `defining-cube.md` skill needs to be authored.

### App UI updates

19. `LoggerTableForm` "dimension" field label → "Semantic equivalence" (or similar — needs UX wordsmithing). The help text should explicitly say this is a provenance tag, not a query source.
20. `DimensionForm` "Source Table / Source Column" fields → "Resolution Bindings" with a multi-row editor (since the target model is multi-binding).
21. `EntityForm` should surface the implicit Dimension somewhere — at minimum a read-only line saying "creates dimension `<id_field>`."
22. `EntityForm` should not enforce the `_id` suffix on `id_field` (currently may be doing so via help text or inline validation). Show it as a recommendation, not a requirement.
23. `LattikTableForm` primary-key editor should reference Dimensions instead of Entities (a dropdown of available Dimensions, defaulting to the implicit id Dimensions of declared Entities), and should *only* offer entity Dimensions — never time Dimensions, since the latter shouldn't exist.
24. `LattikTableForm` column-family editor should expose the optional `load_cadence` field with a "(inferred from source)" default, and warn if a user mixes cadences on a single table (deliberate choice — not an error).
25. New `CubeForm` for the canvas, scoped to the Cube workflow.

## See also

- [defining-entity.md](../../apps/web/src/extensions/data-architect/skills/defining-entity.md)
- [defining-dimension.md](../../apps/web/src/extensions/data-architect/skills/defining-dimension.md)
- [defining-logger-table.md](../../apps/web/src/extensions/data-architect/skills/defining-logger-table.md)
- [defining-lattik-table.md](../../apps/web/src/extensions/data-architect/skills/defining-lattik-table.md)
- [defining-metric.md](../../apps/web/src/extensions/data-architect/skills/defining-metric.md)
- [Data Architect extension README](../../apps/web/src/extensions/data-architect/README.md)
- Cube.dev docs: <https://cube.dev/docs/>
- dbt Semantic Layer / MetricFlow docs: <https://docs.getdbt.com/docs/build/about-metricflow>
- LookML reference: <https://cloud.google.com/looker/docs/lookml-quick-reference>
- Malloy docs: <https://malloydata.dev/>
