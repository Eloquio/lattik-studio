import type { ColumnType } from "../types.js";

/** A column definition from a Logger Table spec. */
export interface LoggerColumn {
  name: string;
  type: ColumnType;
  description?: string;
}

/** Input for generating a per-table payload .proto file. */
export interface ProtoGenInput {
  /** Fully qualified table name, e.g. "ingest.click_events". */
  table: string;
  /** User-defined columns (implicit columns are not included). */
  columns: LoggerColumn[];
}

const COLUMN_TYPE_TO_PROTO: Record<ColumnType, string> = {
  string: "string",
  int32: "int32",
  int64: "int64",
  float: "float",
  double: "double",
  boolean: "bool",
  timestamp: "string",
  date: "string",
  json: "bytes",
};

/**
 * Converts a table name like "ingest.click_events" to a PascalCase
 * protobuf message name like "IngestClickEvents".
 */
function tableNameToMessageName(table: string): string {
  return table
    .split(/[._]/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/**
 * Generates .proto file content for a Logger Table's payload message.
 *
 * All fields are `optional` since Logger Table columns are nullable.
 * Field numbers are assigned in column-definition order starting at 1.
 *
 * @example
 * ```ts
 * generatePayloadProto({
 *   table: "ingest.click_events",
 *   columns: [
 *     { name: "user_id", type: "string" },
 *     { name: "url", type: "string" },
 *     { name: "is_bot", type: "boolean" },
 *   ],
 * });
 * // => proto3 file with message IngestClickEvents { ... }
 * ```
 */
export function generatePayloadProto(input: ProtoGenInput): string {
  const messageName = tableNameToMessageName(input.table);
  const lines: string[] = [
    `// Generated from Logger Table "${input.table}"`,
    `// Do not edit — regenerate from the table definition.`,
    `syntax = "proto3";`,
    ``,
    `package lattik.logger.v1;`,
    ``,
    `message ${messageName} {`,
  ];

  for (let i = 0; i < input.columns.length; i++) {
    const col = input.columns[i]!;
    const protoType = COLUMN_TYPE_TO_PROTO[col.type];
    const fieldNumber = i + 1;
    if (col.description) {
      lines.push(`  // ${col.description}`);
    }
    lines.push(`  optional ${protoType} ${col.name} = ${fieldNumber};`);
  }

  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

/**
 * Derives the .proto filename from a table name.
 * e.g. "ingest.click_events" → "ingest_click_events.proto"
 */
export function tableNameToProtoFilename(table: string): string {
  return table.replace(/\./g, "_") + ".proto";
}
