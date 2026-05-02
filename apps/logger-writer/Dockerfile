# Lattik logger-writer — per-table Kafka -> Iceberg consumer.
#
# Build context: this directory (apps/logger-writer/). The image is shared
# across every per-table Deployment; each Deployment supplies LOGGER_TABLE
# and other env values.
#
# We use cargo-chef so dep compilation is cached as a Docker layer — warm
# rebuilds touch only src/, not the multi-hundred-crate dep tree.

# Pin to the same toolchain the host uses (currently 1.92). iceberg 0.9 +
# iceberg-catalog-rest 0.9 require 1.92 transitively.
FROM rust:1.92-bookworm AS chef
RUN cargo install --locked cargo-chef@0.1.68
WORKDIR /app

# 1. recipe.json captures the dependency graph so step (3) is fully cached
#    until Cargo.toml changes.
FROM chef AS planner
COPY Cargo.toml Cargo.lock* ./
COPY build.rs ./
COPY proto ./proto
COPY src ./src
RUN cargo chef prepare --recipe-path recipe.json

# 2. Build dependencies only — this layer caches until Cargo.toml changes.
FROM chef AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake \
        protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# 3. Build the app on top of cached deps.
COPY Cargo.toml Cargo.lock* ./
COPY build.rs ./
COPY proto ./proto
COPY src ./src
RUN cargo build --release --bin logger-writer

# 4. Slim runtime — librdkafka brings glibc + cyrus-sasl + lz4 + zstd,
#    nothing exotic.
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libsasl2-2 \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/logger-writer /usr/local/bin/logger-writer
ENV RUST_LOG=info,logger_writer=debug,rdkafka=info
ENTRYPOINT ["/usr/local/bin/logger-writer"]
