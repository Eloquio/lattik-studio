/**
 * `emit_logger_proto` — render and write the per-table .proto file for a
 * Logger Table so the lattik-logger package can serialize events for it.
 *
 * Uses `generatePayloadProto` from `@eloquio/lattik-logger` and writes to
 * `packages/lattik-logger/proto/lattik/logger/v1/<table>.proto`. Refreshing
 * TS bindings (`buf generate`) is intentionally NOT done here — spawning
 * pnpm from inside the worker process race-corrupts the next run's skill
 * loading. Run `pnpm --filter @eloquio/lattik-logger build` separately.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tool, zodSchema } from "ai";
import {
  generatePayloadProto,
  tableNameToProtoFilename,
  type LoggerColumn,
} from "@eloquio/lattik-logger";
import { toolOutputSchema } from "./shared.js";

const outputSchema = toolOutputSchema(
  z.object({
    path: z.string().optional(),
    columns: z.number().int().optional(),
    note: z.string().optional(),
  }),
);
type Output = z.infer<typeof outputSchema>;

// Walk up from this file: apps/agent-worker/src/tools/ → repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "../../../..");
const REPO_ROOT = process.env.LATTIK_REPO_ROOT ?? DEFAULT_REPO_ROOT;

const PROTO_DIR = resolve(
  REPO_ROOT,
  "packages/lattik-logger/proto/lattik/logger/v1",
);

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

export const emitLoggerProtoTool = tool({
  description:
    "Render a Protobuf message definition for a Logger Table and write it to the lattik-logger package's proto directory. Returns `{ ok, path, columns, ... }`. Does NOT regenerate TS bindings — that's a separate `pnpm` step.",
  inputSchema: zodSchema(
    z.object({
      table_name: z
        .string()
        .min(1)
        .describe(
          "Logger table name in `<schema>.<table>` form, e.g. `ingest.click_events`",
        ),
      columns: z
        .array(columnSchema)
        .min(1)
        .describe(
          "User-defined columns from the merged spec — each `{name, type, description?}`. Implicit columns (event_id, event_timestamp, ds, hour) must NOT be redeclared.",
        ),
    }),
  ),
  outputSchema: zodSchema(outputSchema),
  execute: async (input: {
    table_name: string;
    columns: LoggerColumn[];
  }): Promise<Output> => {
    const protoContent = generatePayloadProto({
      table: input.table_name,
      columns: input.columns,
    });
    const filename = tableNameToProtoFilename(input.table_name);
    const protoPath = resolve(PROTO_DIR, filename);

    try {
      await mkdir(PROTO_DIR, { recursive: true });
      await writeFile(protoPath, protoContent, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `proto write failed (${protoPath}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      ok: true,
      path: protoPath,
      columns: input.columns.length,
      note: "Run `pnpm --filter @eloquio/lattik-logger build` to refresh TS bindings.",
    };
  },
});
