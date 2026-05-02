//! Runtime config — every value is env-driven so the same image runs every
//! per-table Deployment unmodified.

use anyhow::{anyhow, Context, Result};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    /// Logger table in `<schema>.<table>` form, e.g. `ingest.clicks`.
    pub logger_table: String,
    /// Schema half of `logger_table`.
    pub schema: String,
    /// Table half of `logger_table`.
    pub table: String,
    /// Kafka topic this writer subscribes to: `logger.<logger_table>`.
    pub kafka_topic: String,
    /// Comma-separated bootstrap brokers.
    pub kafka_brokers: String,
    /// Kafka consumer group id, derived as `logger-writer-<schema>-<table>`.
    pub consumer_group: String,
    /// Confluent Schema Registry base URL.
    pub schema_registry_url: String,
    /// Iceberg REST catalog URL.
    pub iceberg_rest_url: String,
    /// S3 endpoint (MinIO in local dev).
    pub s3_endpoint: String,
    /// S3 access key id.
    pub s3_access_key_id: String,
    /// S3 secret access key.
    pub s3_secret_access_key: String,
    /// Iceberg warehouse path prefix (e.g. `s3://warehouse`).
    pub warehouse: String,
    /// Flush whenever this many rows have accumulated.
    pub flush_rows: usize,
    /// Flush whenever this much wall time has passed since the last flush.
    pub flush_interval: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let logger_table =
            env_required("LOGGER_TABLE")?;
        let (schema, table) = logger_table
            .split_once('.')
            .map(|(s, t)| (s.to_string(), t.to_string()))
            .ok_or_else(|| {
                anyhow!("LOGGER_TABLE must be `<schema>.<table>`, got: {logger_table}")
            })?;

        Ok(Self {
            kafka_topic: format!("logger.{logger_table}"),
            consumer_group: format!("logger-writer-{schema}-{table}"),
            kafka_brokers: env_or("KAFKA_BROKERS", "kafka.kafka:9092"),
            schema_registry_url: env_or(
                "SCHEMA_REGISTRY_URL",
                "http://sr.schema-registry:8081",
            ),
            iceberg_rest_url: env_or(
                "ICEBERG_REST_URL",
                "http://iceberg-rest.iceberg:8181",
            ),
            s3_endpoint: env_or("S3_ENDPOINT", "http://minio.minio:9000"),
            s3_access_key_id: env_or("S3_ACCESS_KEY_ID", "lattik"),
            s3_secret_access_key: env_or("S3_SECRET_ACCESS_KEY", "lattik-local"),
            warehouse: env_or("LATTIK_WAREHOUSE_PATH", "s3://warehouse"),
            flush_rows: env_or("FLUSH_ROWS", "10000")
                .parse()
                .context("FLUSH_ROWS must be a positive integer")?,
            flush_interval: Duration::from_secs(
                env_or("FLUSH_INTERVAL_SECONDS", "5")
                    .parse()
                    .context("FLUSH_INTERVAL_SECONDS must be a positive integer")?,
            ),
            schema,
            table,
            logger_table,
        })
    }
}

fn env_required(key: &str) -> Result<String> {
    std::env::var(key).map_err(|_| anyhow!("{key} is required"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
