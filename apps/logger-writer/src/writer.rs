//! Writer main loop.
//!
//! End-to-end: subscribe → decode envelope → buffer → on flush, decode each
//! payload via the per-table descriptor, build an Arrow batch matching the
//! Iceberg table schema, write Parquet, append it with `kafka_offset_p<n>`
//! snapshot properties, then commit Kafka offsets.

use crate::config::Config;
use crate::iceberg_io;
use crate::iceberg_write::{BufferedMessage, write_batch};
use crate::proto_envelope::Envelope;
use crate::schema as proto_schema;
use anyhow::{Context, Result};
use prost::Message;
use prost_reflect::MessageDescriptor;
use rdkafka::Timestamp;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::Message as _;
use rdkafka::{Offset, TopicPartitionList};
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::Instant;
use tracing::{info, warn};

pub async fn run(cfg: Config) -> Result<()> {
    let catalog = iceberg_io::build_catalog(&cfg)
        .await
        .context("build iceberg catalog")?;
    let mut table = iceberg_io::load_table(&catalog, &cfg)
        .await
        .context("load iceberg table")?;
    info!(
        table = %cfg.logger_table,
        location = %table.metadata().location(),
        "iceberg table loaded",
    );

    let descriptor: MessageDescriptor = proto_schema::load_message_descriptor(&cfg)
        .await
        .context("load message descriptor from Schema Registry")?;
    info!(message = %descriptor.full_name(), "loaded payload descriptor from SR");

    let resolved_hwm = iceberg_io::resolve_hwm(&table);
    info!(
        partitions_with_hwm = resolved_hwm.len(),
        ?resolved_hwm,
        "resolved per-partition HWM from snapshots",
    );

    let consumer = build_consumer(&cfg).context("kafka consumer init")?;
    consumer
        .subscribe(&[cfg.kafka_topic.as_str()])
        .with_context(|| format!("subscribe to {}", cfg.kafka_topic))?;
    info!(topic = %cfg.kafka_topic, group = %cfg.consumer_group, "kafka consumer subscribed");

    if !resolved_hwm.is_empty() {
        seek_to_hwm(&consumer, &cfg.kafka_topic, &resolved_hwm)
            .context("seek to HWM")?;
    }

    let mut last_flush = Instant::now();
    let mut buffer: Vec<BufferedMessage> = Vec::with_capacity(cfg.flush_rows);
    let mut pending_hwm: HashMap<i32, i64> = HashMap::new();

    loop {
        let timeout = cfg
            .flush_interval
            .checked_sub(last_flush.elapsed())
            .unwrap_or(Duration::from_millis(0));

        tokio::select! {
            msg = consumer.recv() => {
                match msg {
                    Ok(borrowed) => {
                        let partition = borrowed.partition();
                        let offset = borrowed.offset();
                        let kafka_timestamp_ms = match borrowed.timestamp() {
                            Timestamp::CreateTime(ms) | Timestamp::LogAppendTime(ms) => ms,
                            // Older brokers / mis-configured topics may report
                            // NotAvailable. Falling back to wall-clock at consume
                            // keeps grouping infallible — at worst a row lands in
                            // the consumer's hour rather than the broker's.
                            Timestamp::NotAvailable => chrono::Utc::now().timestamp_millis(),
                        };
                        let bytes = borrowed.payload().unwrap_or_default();
                        match Envelope::decode(bytes) {
                            Ok(env) => {
                                buffer.push(BufferedMessage {
                                    envelope: env,
                                    kafka_timestamp_ms,
                                });
                                pending_hwm
                                    .entry(partition)
                                    .and_modify(|cur| {
                                        if offset > *cur { *cur = offset }
                                    })
                                    .or_insert(offset);
                                if buffer.len() >= cfg.flush_rows {
                                    table = flush(
                                        &catalog,
                                        table,
                                        &descriptor,
                                        &consumer,
                                        &mut buffer,
                                        &mut pending_hwm,
                                        &mut last_flush,
                                    ).await?;
                                }
                            }
                            Err(err) => {
                                warn!(error = %err, "skipping un-decodable envelope");
                            }
                        }
                    }
                    Err(err) => {
                        warn!(error = %err, "kafka recv error; backing off");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
            _ = tokio::time::sleep(timeout) => {
                table = flush(
                    &catalog,
                    table,
                    &descriptor,
                    &consumer,
                    &mut buffer,
                    &mut pending_hwm,
                    &mut last_flush,
                ).await?;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn flush(
    catalog: &iceberg_catalog_rest::RestCatalog,
    table: iceberg::table::Table,
    descriptor: &MessageDescriptor,
    consumer: &StreamConsumer,
    buffer: &mut Vec<BufferedMessage>,
    pending_hwm: &mut HashMap<i32, i64>,
    last_flush: &mut Instant,
) -> Result<iceberg::table::Table> {
    *last_flush = Instant::now();
    if buffer.is_empty() {
        return Ok(table);
    }
    let row_count = buffer.len();
    let new_table = match write_batch(catalog, table, descriptor, buffer, pending_hwm).await {
        Ok(t) => t,
        Err(err) => {
            // Iceberg commit failed — leave buffer + HWM in place so the
            // next flush retries. Do NOT advance Kafka offsets. Log the
            // full anyhow chain so we can see the underlying source.
            let chain = err.chain().map(|e| e.to_string()).collect::<Vec<_>>().join("\n  caused by: ");
            warn!("iceberg commit failed; buffer retained for retry: {chain}");
            *last_flush = Instant::now();
            return Err(err);
        }
    };

    // Iceberg commit succeeded — now best-effort commit Kafka offsets. The
    // snapshot property is the authoritative HWM; offset commit is just a
    // hint to avoid replay on the happy path.
    if let Err(err) = consumer.commit_consumer_state(CommitMode::Sync) {
        warn!(error = %err, "kafka offset commit failed (HWM property is authoritative)");
    }

    info!(
        rows = row_count,
        ?pending_hwm,
        "flush committed (iceberg snapshot + kafka offsets)",
    );
    buffer.clear();
    pending_hwm.clear();
    Ok(new_table)
}

fn seek_to_hwm(
    consumer: &StreamConsumer,
    topic: &str,
    hwm: &HashMap<i32, i64>,
) -> Result<()> {
    let mut tpl = TopicPartitionList::new();
    for (&partition, &offset) in hwm.iter() {
        tpl.add_partition_offset(topic, partition, Offset::Offset(offset + 1))
            .with_context(|| {
                format!("add_partition_offset(topic={topic}, p={partition})")
            })?;
    }
    consumer.assign(&tpl).context("assign hwm-derived offsets")?;
    info!(
        partitions = hwm.len(),
        "seeked consumer past HWM (will resume past these offsets)",
    );
    Ok(())
}

fn build_consumer(cfg: &Config) -> Result<StreamConsumer> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &cfg.kafka_brokers)
        .set("group.id", &cfg.consumer_group)
        .set("enable.auto.commit", "false")
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "10000")
        .create()
        .context("rdkafka StreamConsumer::create")?;
    Ok(consumer)
}
