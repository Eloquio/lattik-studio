//! Per-flush Iceberg write path.
//!
//! Given a buffered batch of envelopes + the dynamic message descriptor for
//! the per-table payload, builds an Arrow `RecordBatch` matching the table's
//! schema, writes a Parquet file via iceberg-rust's writer chain, then
//! atomically appends it to the table with `kafka_offset_p<n>` snapshot
//! properties for HWM tracking.
//!
//! Partition columns `ds` / `hour` are derived from the **Kafka append
//! timestamp**, not the envelope's `event_timestamp`. Using broker-side
//! ingestion time keeps partitions aligned with the order in which we
//! consume — late-arriving events with backdated `event_timestamp` still
//! land in the partition for the hour they were ingested, so partitions
//! never need backfill rewrites.

use crate::hwm;
use crate::proto_envelope::Envelope;
use anyhow::{Context, Result, anyhow};
use arrow_array::{
    ArrayRef, BooleanArray, Float32Array, Float64Array, Int32Array, Int64Array, RecordBatch,
    StringArray, TimestampMicrosecondArray,
};
use arrow_schema::{DataType, TimeUnit};
use chrono::{DateTime, Datelike, Timelike, Utc};

/// One buffered Kafka message awaiting flush. Carries the decoded envelope
/// plus the Kafka append-time timestamp (ms since epoch) we use to derive
/// the `(ds, hour)` partition.
pub struct BufferedMessage {
    pub envelope: Envelope,
    pub kafka_timestamp_ms: i64,
}
use iceberg::arrow::schema_to_arrow_schema;
use iceberg::spec::{DataFile, Literal, PartitionKey, Struct};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::writer::base_writer::data_file_writer::DataFileWriterBuilder;
use iceberg::writer::file_writer::ParquetWriterBuilder;
use iceberg::writer::file_writer::location_generator::{
    DefaultFileNameGenerator, DefaultLocationGenerator,
};
use iceberg::writer::file_writer::rolling_writer::RollingFileWriterBuilder;
use iceberg::writer::partitioning::PartitioningWriter;
use iceberg::writer::partitioning::fanout_writer::FanoutWriter;
use iceberg_catalog_rest::RestCatalog;
use parquet::basic::Compression;
use parquet::file::properties::{WriterProperties, WriterVersion};
use prost_reflect::{DynamicMessage, MessageDescriptor, ReflectMessage, Value as ReflectValue};
use std::collections::HashMap;
use uuid::Uuid;
use std::sync::Arc;
use tracing::warn;

struct Row<'a> {
    envelope: &'a Envelope,
    payload: Option<DynamicMessage>,
    kafka_timestamp_ms: i64,
}

impl<'a> Row<'a> {
    fn field<'b>(&'b self, name: &str) -> Option<prost_reflect::FieldDescriptor> {
        let msg = self.payload.as_ref()?;
        let f = msg.descriptor().get_field_by_name(name)?;
        if msg.has_field(&f) { Some(f) } else { None }
    }

    fn value<R>(
        &self,
        name: &str,
        f: impl FnOnce(&ReflectValue) -> Option<R>,
    ) -> Option<R> {
        let field = self.field(name)?;
        let msg = self.payload.as_ref()?;
        let cow = msg.get_field(&field);
        f(cow.as_ref())
    }
}

/// Write a buffered batch to the table and commit. Groups rows by their
/// `(ds, hour)` partition key, writes one Parquet file per partition via
/// `FanoutWriter`, then commits all data files in a single Iceberg snapshot
/// with HWM properties. Returns the resulting `Table`.
pub async fn write_batch(
    catalog: &RestCatalog,
    table: Table,
    descriptor: &MessageDescriptor,
    messages: &[BufferedMessage],
    hwm_map: &std::collections::HashMap<i32, i64>,
) -> Result<Table> {
    if messages.is_empty() {
        return Ok(table);
    }

    let arrow_schema = schema_to_arrow_schema(table.metadata().current_schema())
        .context("convert iceberg schema to arrow schema")?;

    // Decode payloads up front. Failures are surfaced as warnings; the row
    // still emits with NULL user columns so we don't lose envelope metadata.
    let rows: Vec<Row> = messages
        .iter()
        .map(|msg| {
            let payload = match DynamicMessage::decode(
                descriptor.clone(),
                msg.envelope.payload.as_slice(),
            ) {
                Ok(m) => Some(m),
                Err(err) => {
                    warn!(
                        error = %err,
                        event_id = %msg.envelope.event_id,
                        "failed to decode payload; user columns will be null",
                    );
                    None
                }
            };
            Row {
                envelope: &msg.envelope,
                payload,
                kafka_timestamp_ms: msg.kafka_timestamp_ms,
            }
        })
        .collect();

    // Group rows by the (ds, hour) pair derived from the Kafka append-time
    // timestamp. The kafka_timestamp_ms is always set (caller falls back to
    // wall-clock time at consume if the broker reports NotAvailable), so
    // grouping is infallible and we never drop rows here.
    let mut groups: HashMap<(String, String), Vec<&Row>> = HashMap::new();
    for row in &rows {
        let ds = derive_ds(row.kafka_timestamp_ms);
        let hour = derive_hour(row.kafka_timestamp_ms);
        groups.entry((ds, hour)).or_default().push(row);
    }
    if groups.is_empty() {
        return Ok(table);
    }

    let data_files = write_partitioned(&table, &arrow_schema, groups).await?;

    let tx = Transaction::new(&table);
    let snapshot_props = hwm::to_snapshot_properties(hwm_map);
    let action = tx
        .fast_append()
        .set_snapshot_properties(snapshot_props)
        .add_data_files(data_files);
    let tx = action.apply(tx).context("apply fast_append action")?;
    tx.commit(catalog).await.context("commit transaction")
}

async fn write_partitioned(
    table: &Table,
    arrow_schema: &arrow_schema::Schema,
    groups: HashMap<(String, String), Vec<&Row<'_>>>,
) -> Result<Vec<DataFile>> {
    let file_io = table.file_io().clone();
    let location_generator = DefaultLocationGenerator::new(table.metadata().clone())
        .context("location generator")?;
    let file_name_generator = DefaultFileNameGenerator::new(
        format!("logger-writer-{}", Uuid::now_v7()),
        None,
        iceberg::spec::DataFileFormat::Parquet,
    );

    // Pin Parquet 1.0 writer version — parquet-mr in Trino 480 trips on the
    // v2 data page header layout that parquet-rs writes by default.
    let parquet_props = WriterProperties::builder()
        .set_writer_version(WriterVersion::PARQUET_1_0)
        .set_compression(Compression::SNAPPY)
        .build();
    let parquet_builder = ParquetWriterBuilder::new(
        parquet_props,
        table.metadata().current_schema().clone(),
    );
    let rolling_builder = RollingFileWriterBuilder::new_with_default_file_size(
        parquet_builder,
        file_io,
        location_generator,
        file_name_generator,
    );
    let data_file_builder = DataFileWriterBuilder::new(rolling_builder);

    let mut fanout: FanoutWriter<_> = FanoutWriter::new(data_file_builder);

    let partition_spec = table.metadata().default_partition_spec().clone();
    let table_schema = table.metadata().current_schema().clone();

    for ((ds, hour), rows) in groups {
        let partition_struct = Struct::from_iter([
            Some(Literal::string(&ds)),
            Some(Literal::string(&hour)),
        ]);
        let partition_key = PartitionKey::new(
            partition_spec.as_ref().clone(),
            table_schema.clone(),
            partition_struct,
        );

        let batch = build_record_batch(arrow_schema, &rows, &ds, &hour)?;
        fanout
            .write(partition_key, batch)
            .await
            .with_context(|| format!("fanout.write(ds={ds}, hour={hour})"))?;
    }

    fanout.close().await.context("fanout.close")
}

fn build_record_batch(
    arrow_schema: &arrow_schema::Schema,
    rows: &[&Row<'_>],
    ds: &str,
    hour: &str,
) -> Result<RecordBatch> {
    let n = rows.len();
    let mut columns: Vec<ArrayRef> = Vec::with_capacity(arrow_schema.fields().len());
    for field in arrow_schema.fields() {
        let array: ArrayRef = match field.name().as_str() {
            "event_id" => Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| r.envelope.event_id.as_str()),
            )),
            "event_timestamp" => Arc::new(TimestampMicrosecondArray::from(
                rows.iter()
                    .map(|r| parse_timestamp_micros(&r.envelope.event_timestamp))
                    .collect::<Vec<Option<i64>>>(),
            )),
            // Partition columns are constant within this group — every row
            // shares the same (ds, hour) pair we keyed the group by.
            "ds" => Arc::new(StringArray::from_iter_values(
                std::iter::repeat(ds).take(n),
            )),
            "hour" => Arc::new(StringArray::from_iter_values(
                std::iter::repeat(hour).take(n),
            )),
            // Any other field is a user-defined column; pluck from the
            // dynamic message by field name.
            user_field => build_user_column(user_field, field.data_type(), rows)?,
        };
        columns.push(array);
    }
    RecordBatch::try_new(Arc::new(arrow_schema.clone()), columns)
        .context("RecordBatch::try_new")
}

fn build_user_column(
    field_name: &str,
    data_type: &DataType,
    rows: &[&Row<'_>],
) -> Result<ArrayRef> {
    Ok(match data_type {
        DataType::Utf8 => Arc::new(StringArray::from(
            rows.iter()
                .map(|r| {
                    r.value(field_name, |v| match v {
                        ReflectValue::String(s) => Some(s.clone()),
                        _ => None,
                    })
                })
                .collect::<Vec<Option<String>>>(),
        )),
        DataType::Int32 => Arc::new(Int32Array::from_iter(rows.iter().map(|r| {
            r.value(field_name, |v| match v {
                ReflectValue::I32(i) => Some(*i),
                ReflectValue::I64(i) => i32::try_from(*i).ok(),
                _ => None,
            })
        }))),
        DataType::Int64 => Arc::new(Int64Array::from_iter(rows.iter().map(|r| {
            r.value(field_name, |v| match v {
                ReflectValue::I64(i) => Some(*i),
                ReflectValue::I32(i) => Some(*i as i64),
                _ => None,
            })
        }))),
        DataType::Float32 => Arc::new(Float32Array::from_iter(rows.iter().map(|r| {
            r.value(field_name, |v| match v {
                ReflectValue::F32(f) => Some(*f),
                ReflectValue::F64(f) => Some(*f as f32),
                _ => None,
            })
        }))),
        DataType::Float64 => Arc::new(Float64Array::from_iter(rows.iter().map(|r| {
            r.value(field_name, |v| match v {
                ReflectValue::F64(f) => Some(*f),
                ReflectValue::F32(f) => Some(*f as f64),
                _ => None,
            })
        }))),
        DataType::Boolean => Arc::new(BooleanArray::from(
            rows.iter()
                .map(|r| {
                    r.value(field_name, |v| match v {
                        ReflectValue::Bool(b) => Some(*b),
                        _ => None,
                    })
                })
                .collect::<Vec<Option<bool>>>(),
        )),
        DataType::Timestamp(TimeUnit::Microsecond, _) => {
            Arc::new(TimestampMicrosecondArray::from(
                rows.iter()
                    .map(|r| {
                        r.value(field_name, |v| match v {
                            ReflectValue::String(s) => parse_timestamp_micros(s),
                            _ => None,
                        })
                    })
                    .collect::<Vec<Option<i64>>>(),
            ))
        }
        other => {
            return Err(anyhow!(
                "unsupported user column type for field `{field_name}`: {other:?}"
            ));
        }
    })
}

fn parse_timestamp_micros(ts: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_micros())
}

fn derive_ds(ts_ms: i64) -> String {
    let dt = ms_to_utc(ts_ms);
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

fn derive_hour(ts_ms: i64) -> String {
    let dt = ms_to_utc(ts_ms);
    format!("{:02}", dt.hour())
}

fn ms_to_utc(ts_ms: i64) -> DateTime<Utc> {
    // i64 millis covers ~292M years either side of the epoch, so this is
    // infallible for any timestamp Kafka could plausibly emit.
    DateTime::<Utc>::from_timestamp_millis(ts_ms).unwrap_or_else(Utc::now)
}
