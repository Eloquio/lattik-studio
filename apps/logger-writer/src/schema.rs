//! Per-table Protobuf schema fetched from Confluent Schema Registry.
//!
//! At startup we GET `/subjects/logger.<table>-value/versions/latest`,
//! parse the returned .proto text into a `FileDescriptorProto`, register
//! it in a `prost_reflect::DescriptorPool`, and look up the per-table
//! message descriptor by its expected name (PascalCase of the table name).
//! That descriptor lets us call `DynamicMessage::decode(descriptor, bytes)`
//! on every envelope payload at runtime.

use crate::config::Config;
use anyhow::{Context, Result, anyhow};
use prost::Message;
use prost_reflect::{DescriptorPool, MessageDescriptor};
use prost_types::FileDescriptorProto;
use serde::Deserialize;
use std::io::Write;
use tempfile::TempDir;

#[derive(Deserialize, Debug)]
struct SrSchemaResponse {
    schema: String,
    #[serde(default)]
    #[allow(dead_code)]
    id: u32,
    #[serde(default)]
    #[allow(dead_code)]
    version: u32,
}

/// Fetch the .proto text registered for `subject` (latest version).
pub async fn fetch_proto_text(cfg: &Config) -> Result<String> {
    let subject = format!("logger.{}-value", cfg.logger_table);
    let url = format!(
        "{}/subjects/{}/versions/latest",
        cfg.schema_registry_url.trim_end_matches('/'),
        urlencoding::encode(&subject),
    );
    let resp = reqwest::get(&url)
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Schema Registry returned {status} for subject {subject}: {body}"
        ));
    }
    let parsed: SrSchemaResponse = resp.json().await.context("parse SR response")?;
    Ok(parsed.schema)
}

/// Parse .proto text into a `FileDescriptorProto`. We write the text to a
/// tempfile and let `protobuf-parse` (a pure-Rust .proto parser) handle it.
fn parse_proto_text(proto: &str) -> Result<FileDescriptorProto> {
    let dir = TempDir::new().context("tempdir")?;
    let path = dir.path().join("payload.proto");
    let mut f = std::fs::File::create(&path).context("create proto tempfile")?;
    f.write_all(proto.as_bytes()).context("write proto text")?;
    drop(f);

    let mut fileset = protobuf_parse::Parser::new()
        .pure()
        .include(dir.path())
        .input(&path)
        .file_descriptor_set()
        .context("protobuf-parse")?;
    let parsed_file = fileset
        .file
        .pop()
        .ok_or_else(|| anyhow!("no FileDescriptorProto returned by parser"))?;
    // protobuf 3.7 returns its own FileDescriptorProto type; re-encode it
    // and decode as prost-types so prost-reflect can consume it.
    let bytes = protobuf::Message::write_to_bytes(&parsed_file)
        .context("re-encode FileDescriptorProto")?;
    FileDescriptorProto::decode(bytes.as_slice())
        .context("decode FileDescriptorProto into prost-types")
}

/// Compute the Pascal-cased message name we expect inside the file. Matches
/// `tableNameToMessageName` in the lattik-logger TS package, e.g.
/// `ingest.click_events` → `IngestClickEvents`.
fn table_message_name(logger_table: &str) -> String {
    logger_table
        .split(['.', '_'])
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Fetch + compile + look up the message descriptor for the configured
/// logger table. Done once at writer startup; the returned descriptor is
/// reused for every payload decode.
pub async fn load_message_descriptor(cfg: &Config) -> Result<MessageDescriptor> {
    let proto_text = fetch_proto_text(cfg).await?;
    let file_desc = parse_proto_text(&proto_text)?;
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_proto(file_desc)
        .context("register file descriptor in pool")?;

    let msg_name = table_message_name(&cfg.logger_table);
    // The .proto file's package is `lattik.logger.v1`, so the fully-qualified
    // message name we register is `lattik.logger.v1.<MessageName>`.
    let fq = format!("lattik.logger.v1.{msg_name}");
    pool.get_message_by_name(&fq)
        .ok_or_else(|| anyhow!("message {fq} not found in registered file descriptor"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascal_case_message_name() {
        assert_eq!(table_message_name("ingest.click_events"), "IngestClickEvents");
        assert_eq!(table_message_name("ingest.clicks"), "IngestClicks");
        assert_eq!(table_message_name("schema.table_name"), "SchemaTableName");
    }
}
