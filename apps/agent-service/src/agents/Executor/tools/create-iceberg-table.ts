/**
 * `create_iceberg_table` — issue CREATE SCHEMA + CREATE TABLE IF NOT EXISTS
 * via Trino DDL so a Logger Table has its Iceberg destination ready before
 * the streaming writer starts up.
 *
 * Idempotent: both statements are `IF NOT EXISTS`. The Iceberg REST catalog
 * is shared with Spark, so a table created here is immediately writable
 * from a SparkApplication.
 *
 * Schema: every table gets the four implicit columns (event_id,
 * event_timestamp, ds, hour) plus the user-defined columns from the spec,
 * with their types mapped from the Logger Table column-type enum.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { executeStatement } from "./lib/trino.js";
import { toolOutputSchema } from "./shared.js";

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

type ColumnInput = z.infer<typeof columnSchema>;

// Maps Logger Table column type → Trino DDL type. The Iceberg REST catalog
// translates these to Iceberg field types automatically.
const TYPE_MAP: Record<ColumnInput["type"], string> = {
  string: "varchar",
  int32: "integer",
  int64: "bigint",
  float: "real",
  double: "double",
  boolean: "boolean",
  timestamp: "timestamp(6)",
  date: "date",
  // Iceberg has no JSON type via Trino; store as varchar and let consumers parse.
  json: "varchar",
};

const RESERVED = ["event_id", "event_timestamp", "ds", "hour"];

const outputSchema = toolOutputSchema(
  z.object({
    qualified_name: z.string().optional(),
    schema_created: z.boolean().optional(),
    columns: z.number().int().optional(),
    note: z.string().optional(),
  }),
);
type Output = z.infer<typeof outputSchema>;

function quoteIdent(s: string): string {
  // Trino identifier: double-quote and escape inner double-quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCreateTableSql(
  schema: string,
  table: string,
  userColumns: ColumnInput[],
): string {
  const lines: string[] = [
    `${quoteIdent("event_id")} varchar`,
    `${quoteIdent("event_timestamp")} timestamp(6)`,
    `${quoteIdent("ds")} varchar`,
    `${quoteIdent("hour")} varchar`,
  ];
  for (const c of userColumns) {
    const t = TYPE_MAP[c.type];
    const comment = c.description
      ? ` COMMENT ${"'" + c.description.replace(/'/g, "''") + "'"}`
      : "";
    lines.push(`${quoteIdent(c.name)} ${t}${comment}`);
  }
  return [
    `CREATE TABLE IF NOT EXISTS iceberg.${quoteIdent(schema)}.${quoteIdent(table)} (`,
    lines.map((l) => `  ${l}`).join(",\n"),
    `)`,
    `WITH (partitioning = ARRAY['ds', 'hour'])`,
  ].join("\n");
}

export const createIcebergTableTool = tool({
  description:
    "Create the Iceberg destination table for a Logger Table via Trino DDL. Idempotent — `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS`. The table gets implicit columns (event_id, event_timestamp, ds, hour) plus the user-defined columns, partitioned by `(ds, hour)`. Returns `{ ok, qualified_name, schema_created, columns }`.",
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
          "User-defined columns from the merged spec — each `{name, type, description?}`. Implicit columns (event_id, event_timestamp, ds, hour) MUST NOT be redeclared.",
        ),
    }),
  ),
  outputSchema: zodSchema(outputSchema),
  execute: async (input: {
    table_name: string;
    columns: ColumnInput[];
  }): Promise<Output> => {
    const dot = input.table_name.indexOf(".");
    if (dot < 1 || dot === input.table_name.length - 1) {
      return {
        ok: false,
        error: `table_name must be in <schema>.<table> form; got "${input.table_name}"`,
      };
    }
    const schema = input.table_name.slice(0, dot);
    const table = input.table_name.slice(dot + 1);

    const collisions = input.columns
      .map((c) => c.name)
      .filter((n) => RESERVED.includes(n));
    if (collisions.length > 0) {
      return {
        ok: false,
        error: `user columns must not collide with implicit columns: ${collisions.join(", ")}`,
      };
    }

    try {
      await executeStatement(
        `CREATE SCHEMA IF NOT EXISTS iceberg.${quoteIdent(schema)}`,
      );
      await executeStatement(buildCreateTableSql(schema, table, input.columns));
      return {
        ok: true,
        qualified_name: `iceberg.${schema}.${table}`,
        schema_created: true,
        columns: input.columns.length + RESERVED.length,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
