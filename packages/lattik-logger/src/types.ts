import type { DescMessage, MessageShape } from "@bufbuild/protobuf";

/** Column types matching the Logger Table schema. */
export type ColumnType =
  | "string"
  | "int32"
  | "int64"
  | "float"
  | "double"
  | "boolean"
  | "timestamp"
  | "date"
  | "json";

/** Configuration for creating a LoggerClient. */
export interface LoggerClientConfig<T extends DescMessage> {
  /** Fully qualified table name, e.g. "ingest.click_events". */
  table: string;
  /** Generated protobuf schema for this table's payload. */
  schema: T;
  /** Transport used to deliver serialized envelopes. */
  transport: Transport;
}

/**
 * Pluggable transport interface for delivering serialized envelopes.
 * Receives the protobuf-encoded Envelope as raw bytes.
 */
export interface Transport {
  send(data: Uint8Array): Promise<void>;
}
