/**
 * `register_protobuf_schema` — POST the per-table .proto to Confluent Schema
 * Registry under subject `logger.<table_name>-value` (the value-side subject
 * of the Kafka topic `logger.<table_name>`). The schema content is the
 * payload message — the writer decodes the static envelope itself with prost
 * and uses this SR-stored schema for the per-table payload.
 *
 * Idempotent: SR returns the existing schema id when the content matches an
 * already-registered version.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import {
  generatePayloadProto,
  type LoggerColumn,
} from "@eloquio/lattik-logger";
import { toolOutputSchema } from "./shared.js";

const SCHEMA_REGISTRY_URL =
  process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:8081";

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    "string",
    "int32",
    "int64",
    "float",
    "double",
    "boolean",
    "timestamp",
    "date",
    "json",
  ]),
  description: z.string().optional(),
});

const outputSchema = toolOutputSchema(
  z.object({
    subject: z.string().optional(),
    schema_id: z.number().int().optional(),
    note: z.string().optional(),
  }),
);
type Output = z.infer<typeof outputSchema>;

export const registerProtobufSchemaTool = tool({
  description:
    "Register a Logger Table's Protobuf payload schema in Confluent Schema Registry under subject `logger.<table_name>-value`. Idempotent — SR deduplicates identical schemas and returns the existing id. Returns `{ ok, subject, schema_id }`.",
  inputSchema: zodSchema(
    z.object({
      table_name: z
        .string()
        .min(1)
        .describe(
          "Logger table name in `<schema>.<table>` form, e.g. `ingest.click_events`.",
        ),
      columns: z
        .array(columnSchema)
        .min(1)
        .describe(
          "User-defined columns from the merged spec — each `{name, type, description?}`. Must match what `emit_logger_proto` was called with so the registered schema and the on-disk .proto stay aligned.",
        ),
    }),
  ),
  outputSchema: zodSchema(outputSchema),
  execute: async (input: {
    table_name: string;
    columns: LoggerColumn[];
  }): Promise<Output> => {
    const subject = `logger.${input.table_name}-value`;
    const protoContent = generatePayloadProto({
      table: input.table_name,
      columns: input.columns,
    });

    try {
      const res = await fetch(
        `${SCHEMA_REGISTRY_URL}/subjects/${encodeURIComponent(subject)}/versions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.schemaregistry.v1+json",
            Accept: "application/vnd.schemaregistry.v1+json",
          },
          body: JSON.stringify({
            schema: protoContent,
            schemaType: "PROTOBUF",
          }),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          ok: false,
          error: `Schema Registry returned ${res.status}: ${detail.slice(0, 500)}`,
        };
      }

      const body = (await res.json()) as { id: number };
      return {
        ok: true,
        subject,
        schema_id: body.id,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
