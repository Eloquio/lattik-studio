/**
 * Real tool registry — keyed by the canonical name the LLM calls. Skills
 * declare which tools they need in their frontmatter `tools:` array; the
 * executor wires the matching entries into the agent at build time.
 *
 * Tool names follow the Anthropic API regex `^[a-zA-Z0-9_-]{1,128}$` —
 * underscores and hyphens only, no colons.
 */

import type { Tool } from "ai";
import { createKafkaTopicTool } from "./create-kafka-topic.js";
import { emitLoggerProtoTool } from "./emit-logger-proto.js";
import { registerProtobufSchemaTool } from "./register-protobuf-schema.js";
import { createIcebergTableTool } from "./create-iceberg-table.js";
import { startLoggerWriterTool } from "./start-logger-writer.js";

export const TOOL_REGISTRY: Record<string, Tool> = {
  create_kafka_topic: createKafkaTopicTool,
  emit_logger_proto: emitLoggerProtoTool,
  register_protobuf_schema: registerProtobufSchemaTool,
  create_iceberg_table: createIcebergTableTool,
  start_logger_writer: startLoggerWriterTool,
};

export function getTool(name: string): Tool | null {
  return TOOL_REGISTRY[name] ?? null;
}
