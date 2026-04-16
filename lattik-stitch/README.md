# lattik-stitch

Read-side engine for Lattik Tables: a Rust core (Parquet / Vortex format readers plus two Stitcher implementations — `NaiveStitcher` for hash-join full scans and `IndexedStitcher` for PK index-probe point lookups), exposed to Spark (Kotlin DS V2 catalog) and Trino (Java connector) via a JNI bridge. Combines N column families stored as independent load folders on S3 into a single logical Iceberg-catalog-backed table.

See `projects/lattik-studio/docs/lattik-table-stitch.md` in the sibling repo for the architecture, stitch semantics, manifest format, and time-travel design.

## Building images

This repo produces two Docker images:

- `lattik/spark-stitch` — `apache/spark:4.0.2` + Iceberg runtime + hadoop-aws + AWS SDK v2 + the Kotlin DS V2 plugin + the Rust JNI native lib. Used for Lattik Table materialization jobs and Spark reads.
- `lattik/trino-stitch` — `trinodb/trino:480` + the Java connector plugin + the Rust JNI native lib. Used for Trino reads of the same tables.

Both images are self-contained — they build directly on upstream base images with no dependency on any other locally-built image.

### Using make

```bash
make              # show help + current VERSION
make images       # build both images (sequential)
make -j2 images   # build both images in parallel
make spark-image  # just lattik/spark-stitch
make trino-image  # just lattik/trino-stitch
make version      # print the current VERSION
```

Each `*-image` target runs the full Docker build AND kind-loads the resulting image into the `lattik` cluster. The kind cluster must already exist — from `projects/lattik-studio`, that's `pnpm cluster:up`.

### Directly, without make

```bash
./scripts/image-build.sh spark
./scripts/image-build.sh trino
```

Same behavior — the make targets delegate to this script.

### From the repo root

The root `package.json` has pnpm wrappers that call into this script:

```bash
pnpm stitch:spark:image-build    # → ./lattik-stitch/scripts/image-build.sh spark
pnpm stitch:trino:image-build    # → ./lattik-stitch/scripts/image-build.sh trino
pnpm stitch:image-build          # both, sequentially
```

`pnpm dev:up` also invokes `pnpm stitch:image-build` as part of the normal cluster bring-up.

## Image tags

Each build produces two tags for the same image: an immutable pin tag carrying the full version vector, and a floating `dev-*` tag for local iteration where editing manifests per rebuild is noise.

| Image | Immutable tag | Floating tag |
|---|---|---|
| `lattik/spark-stitch` | `<VERSION>-spark<SPARK_VERSION>-iceberg<ICEBERG_VERSION>` | `dev-spark<SPARK_VERSION>` |
| `lattik/trino-stitch` | `<VERSION>-trino<TRINO_VERSION>` | `dev-trino<TRINO_VERSION>` |

At `VERSION=0.1.0` with the current base images:

- `lattik/spark-stitch:0.1.0-spark4.0.2-iceberg1.10.1` / `lattik/spark-stitch:dev-spark4.0.2`
- `lattik/trino-stitch:0.1.0-trino480` / `lattik/trino-stitch:dev-trino480`

If the working tree has uncommitted changes when you build, the immutable tag gets a `-dirty` suffix so unreproducible artifacts are visible in image listings.

Downstream manifests (e.g. SparkApplication YAML in lattik-studio) should pin to the immutable tag. The floating `dev-*` tag is for local iteration where you want a build to immediately surface without editing YAML.

### Immutability guard

The immutable pin tag is checked against the local Docker daemon before each build. If it already exists, the build refuses to run — the pin tag is supposed to be content-addressed, and silently reassigning it to new content defeats the point of having versioned tags at all. When the guard fires you have three resolution paths:

1. **Bump `VERSION`** (and re-run — the new tag won't collide).
2. **Pass `--force`** (or `FORCE=1` when invoking make) to overwrite the existing tag. Only use this when you are deliberately reproducing a prior build at the same VERSION and same code.
3. **Remove the local image first** with `docker image rm <tag>`.

```bash
./scripts/image-build.sh spark --force
FORCE=1 make spark-image
FORCE=1 make images
```

Dirty builds (working tree with uncommitted changes) are **never** guarded — the `-dirty` suffix already marks them as unreproducible, and they are expected to be overwritten freely during local iteration. The floating `dev-*` tag is also never guarded; it is meant to be reassigned on every build.

## Bumping versions

Four values drive the tag scheme:

| What | Where | Bump when |
|---|---|---|
| `VERSION` | `VERSION` at repo root | Any change to stitch code (Rust, Kotlin, Java) that downstream consumers should pin a new version for |
| `SPARK_VERSION` | `scripts/versions.sh` **and** the `FROM` line in `Dockerfile` | Upgrading Spark |
| `ICEBERG_VERSION` | `scripts/versions.sh` **and** the four iceberg/hadoop-aws curl URLs in `Dockerfile` | Upgrading Iceberg / hadoop-aws / AWS SDK v2 |
| `TRINO_VERSION` | `scripts/versions.sh` **and** the `FROM` line in `Dockerfile.trino` | Upgrading Trino |

Changes must be kept in lockstep with the underlying Dockerfile — `scripts/versions.sh` is tag metadata, not a build-arg source of truth. The tag lies if the two drift.

**Known version-coupling trap.** `Dockerfile.trino`'s Stage 3 hardcodes `COPY --from=java-builder /build/target/lattik-trino-0.1.0/`. The `0.1.0` comes from `java/lattik-trino/pom.xml`'s `<version>`. Bumping the workspace `VERSION` past `0.1.0` therefore also requires a lockstep bump of the POM's `<version>` and that `COPY` line. A cleaner long-term fix is to thread `VERSION` as a Docker build-arg into both files.

## Further reading

- **Design doc:** `projects/lattik-studio/docs/lattik-table-stitch.md` — architecture, stitch semantics, manifest format, time travel.
- **Trino plugin build notes:** [docs/trino-plugin-build.md](docs/trino-plugin-build.md) — JDK 25 / Maven / airlift-airbase requirements for Trino 480+.
