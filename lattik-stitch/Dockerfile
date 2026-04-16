# syntax=docker/dockerfile:1
# Multi-stage build for the Lattik Stitch Spark image.
#
# Stage 1: Build the Rust native library (liblattik_stitch_jni.so)
# Stage 2: Build the Kotlin Spark DS V2 JAR (lattik-spark.jar)
# Stage 3: Assemble the final Spark image with all artifacts
#
# Build (preferred — dual-tags with VERSION + base-image versions):
#   ./scripts/image-build.sh spark
#
# Manual build (no tag hygiene — avoid):
#   docker build -t lattik/spark-stitch:dev .
#   kind load docker-image lattik/spark-stitch:dev --name lattik
#
# The final image is self-contained: it extends apache/spark:4.0.2 directly
# and curls the Iceberg runtime + hadoop-aws + AWS SDK v2 in Stage 3, so it
# has no local-build prerequisites. It builds cleanly on any Docker host
# that can reach Maven Central and apache/spark. Contents added on top of
# the base image:
#
#   /opt/spark/jars/iceberg-spark-runtime-*.jar  — Iceberg Spark connector
#   /opt/spark/jars/iceberg-aws-bundle-*.jar     — S3FileIO + AWS SDK v2
#   /opt/spark/jars/hadoop-aws-*.jar             — s3a:// for non-Iceberg writes
#   /opt/spark/jars/bundle-*.jar                 — AWS SDK v2 for hadoop-aws
#   /opt/spark/jars/lattik-spark.jar             — Spark DS V2 catalog + reader
#   /opt/spark/jars/liblattik_stitch_jni.so      — Rust native stitch engine
#   /opt/spark/jars/arrow-*.jar + flatbuffers + gson — Arrow C Data Interface
#   /opt/spark/jars/postgresql-*.jar             — JDBC driver for manifest resolution
#   requests (pip)                               — used by lattik_table driver scripts
#
# The driver scripts themselves (lattik_table_driver.py, lattik_table_backfill.py,
# lattik_driver_utils.py) are NOT baked in — lattik-studio mounts them at
# runtime via a ConfigMap so they can be edited without rebuilding this image.
#
# Bumping Iceberg / Spark / hadoop-aws / AWS SDK v2 requires editing BOTH the
# curl URLs below AND scripts/versions.sh (which drives the image tag) in
# lockstep — the tag lies otherwise.

# ---- Stage 1: Rust native library ----
FROM rust:1.90-bookworm AS rust-builder

# Vortex's custom-labels crate needs a C++ compiler
RUN apt-get update -qq && apt-get install -y -qq g++ cmake libclang-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace manifest + crate manifests first (for dependency caching)
COPY Cargo.toml Cargo.lock ./
COPY crates/lattik-stitch-core/Cargo.toml crates/lattik-stitch-core/Cargo.toml
COPY crates/lattik-format-parquet/Cargo.toml crates/lattik-format-parquet/Cargo.toml
COPY crates/lattik-stitch-jni/Cargo.toml crates/lattik-stitch-jni/Cargo.toml

# Copy all source and build
COPY crates/ crates/
RUN cargo build --release -p lattik-stitch-jni

# The native lib is at target/release/liblattik_stitch_jni.so (Linux)
# or target/release/liblattik_stitch_jni.dylib (macOS — not used in Docker)

# ---- Stage 2: Kotlin JAR ----
FROM gradle:8.14-jdk17 AS kotlin-builder

WORKDIR /build

# Copy Gradle project files
COPY java/lattik-spark/build.gradle.kts java/lattik-spark/settings.gradle.kts ./

# Download dependencies (cached layer)
RUN gradle dependencies --no-daemon || true

# Copy source
COPY java/lattik-spark/src/ src/

# Copy the native lib from Stage 1 into the expected location for the JAR
COPY --from=rust-builder /build/target/release/liblattik_stitch_jni.so /native/liblattik_stitch_jni.so

# Build the JAR (includes native lib under native/)
RUN gradle jar --no-daemon

# ---- Stage 3: Final Spark image ----
FROM apache/spark:4.0.2

USER root

# Iceberg runtime + S3 connectivity.
#
# These four jars are what lattik-studio's k8s/spark/Dockerfile used to
# provide via the now-deleted lattik/spark-iceberg base image. Inlined here
# so lattik-stitch builds with zero local-image prerequisites.
#
#   iceberg-spark-runtime: Spark SQL connector + Iceberg core
#   iceberg-aws-bundle:    S3FileIO + bundled AWS SDK v2 (no hadoop-aws needed
#                          for Iceberg table writes)
#   hadoop-aws:            s3a:// filesystem — needed for RAW parquet writes
#                          that bypass Iceberg (e.g. stitch load folders)
#   bundle (AWS SDK v2):   classes that hadoop-aws 3.4.x depends on
#
# The `--mount=type=cache` directive gives this RUN (and the arrow RUN
# below) a persistent BuildKit cache at /cache/maven-jars. Downloads land
# there and are reused across builds even when this RUN's text changes or
# the regular layer cache is invalidated — so debug detours that touch
# the RUN block only cost a file-existence check, not a re-download.
# Partial-download caveat: if `docker build` is killed mid-curl, the
# cache may retain a truncated file. Recover with `docker builder prune`.
RUN --mount=type=cache,target=/cache/maven-jars,sharing=locked \
    set -eux; \
    cd /cache/maven-jars; \
    [ -f iceberg-spark-runtime-4.0_2.13-1.10.1.jar ] || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-spark-runtime-4.0_2.13/1.10.1/iceberg-spark-runtime-4.0_2.13-1.10.1.jar"; \
    [ -f iceberg-aws-bundle-1.10.1.jar ]             || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-aws-bundle/1.10.1/iceberg-aws-bundle-1.10.1.jar"; \
    [ -f hadoop-aws-3.4.1.jar ]                      || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-aws/3.4.1/hadoop-aws-3.4.1.jar"; \
    [ -f bundle-2.25.11.jar ]                        || curl -fsSLO "https://repo1.maven.org/maven2/software/amazon/awssdk/bundle/2.25.11/bundle-2.25.11.jar"; \
    cp iceberg-spark-runtime-4.0_2.13-1.10.1.jar \
       iceberg-aws-bundle-1.10.1.jar \
       hadoop-aws-3.4.1.jar \
       bundle-2.25.11.jar \
       /opt/spark/jars/; \
    chown spark:spark /opt/spark/jars/*.jar

# Python dependencies for the lattik_table driver scripts. The scripts
# themselves are mounted at runtime via a ConfigMap (see lattik-studio);
# only their third-party deps need to be baked into the image.
RUN pip install --no-cache-dir requests

# Copy the Lattik Spark JAR
COPY --from=kotlin-builder /build/build/libs/lattik-spark-*.jar /opt/spark/jars/lattik-spark.jar

# Copy the native library (also available standalone for java.library.path)
COPY --from=rust-builder /build/target/release/liblattik_stitch_jni.so /opt/spark/jars/liblattik_stitch_jni.so

# Arrow Java C Data Interface dependencies + postgresql JDBC driver.
# Arrow is needed for importing Arrow RecordBatches from the Rust native
# lib across the JNI boundary. postgresql is the JDBC driver used by the
# LattikCatalog to resolve manifest versions from lattik_table_commits.
#
# Uses the same /cache/maven-jars cache mount as the iceberg RUN above.
RUN --mount=type=cache,target=/cache/maven-jars,sharing=locked \
    set -eux; \
    cd /cache/maven-jars; \
    [ -f arrow-c-data-18.1.0.jar ]          || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/arrow/arrow-c-data/18.1.0/arrow-c-data-18.1.0.jar"; \
    [ -f arrow-vector-18.1.0.jar ]          || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/arrow/arrow-vector/18.1.0/arrow-vector-18.1.0.jar"; \
    [ -f arrow-format-18.1.0.jar ]          || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/arrow/arrow-format/18.1.0/arrow-format-18.1.0.jar"; \
    [ -f arrow-memory-core-18.1.0.jar ]     || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/arrow/arrow-memory-core/18.1.0/arrow-memory-core-18.1.0.jar"; \
    [ -f arrow-memory-netty-18.1.0.jar ]    || curl -fsSLO "https://repo1.maven.org/maven2/org/apache/arrow/arrow-memory-netty/18.1.0/arrow-memory-netty-18.1.0.jar"; \
    [ -f flatbuffers-java-24.3.25.jar ]     || curl -fsSLO "https://repo1.maven.org/maven2/com/google/flatbuffers/flatbuffers-java/24.3.25/flatbuffers-java-24.3.25.jar"; \
    [ -f gson-2.12.1.jar ]                  || curl -fsSLO "https://repo1.maven.org/maven2/com/google/code/gson/gson/2.12.1/gson-2.12.1.jar"; \
    [ -f postgresql-42.7.6.jar ]            || curl -fsSLO "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.6/postgresql-42.7.6.jar"; \
    cp arrow-c-data-18.1.0.jar \
       arrow-vector-18.1.0.jar \
       arrow-format-18.1.0.jar \
       arrow-memory-core-18.1.0.jar \
       arrow-memory-netty-18.1.0.jar \
       flatbuffers-java-24.3.25.jar \
       gson-2.12.1.jar \
       postgresql-42.7.6.jar \
       /opt/spark/jars/; \
    chown spark:spark /opt/spark/jars/*.jar /opt/spark/jars/*.so

USER spark
