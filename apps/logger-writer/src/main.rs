//! Per-table Kafka -> Iceberg consumer for Lattik Logger Tables.
//!
//! One Deployment per logger_table; each pod consumes a partition subset of
//! `logger.<table>` and appends to `iceberg.<schema>.<table>`. Each commit
//! carries a `kafka_offset_p<n>` map in the Iceberg snapshot summary so the
//! writer can resume past committed offsets on restart — exactly-once
//! semantics without per-row dedup.

mod config;
mod hwm;
mod iceberg_io;
mod iceberg_write;
mod proto_envelope;
mod schema;
mod writer;

use anyhow::Result;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("info,logger_writer=debug,rdkafka=info")
        }))
        .with_target(false)
        .compact()
        .init();

    let cfg = config::Config::from_env()?;
    tracing::info!(?cfg, "logger-writer starting");

    writer::run(cfg).await
}
