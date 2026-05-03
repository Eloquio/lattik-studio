import { tool, zodSchema } from "ai";
import { z } from "zod";
import { executeQuery, TrinoQueryError } from "../lib/trino-client.js";

/**
 * Data Analyst's data-access tools.
 *
 * Real implementations this slice:
 *   - listTables — SHOW CATALOGS / SCHEMAS / TABLES against Trino.
 *   - describeTable — DESCRIBE against Trino.
 *
 * Still stubbed (bigger port — needs the canvas-spec builder
 * spec-builder.ts (~150 lines) + the DuckDB client for `lattik_scan`
 * queries (~225 lines), plus canvas-state mutation):
 *   - runQuery — full Trino/DuckDB query path with canvas updates.
 */

export const listTablesTool = tool({
  description:
    "List available catalogs, schemas, or tables in Trino. Use to discover what data is available. " +
    "Call with no arguments to list catalogs. Provide catalog to list schemas. " +
    "Provide catalog + schema to list tables.",
  inputSchema: zodSchema(
    z.object({
      catalog: z
        .string()
        .optional()
        .describe("Catalog name (e.g. 'iceberg'). Omit to list all catalogs."),
      schema: z
        .string()
        .optional()
        .describe("Schema name (e.g. 'ingest'). Requires catalog. Omit to list schemas."),
    }),
  ),
  execute: async (input: { catalog?: string; schema?: string }) => {
    try {
      let sql: string;
      let level: string;
      if (!input.catalog) {
        sql = "SHOW CATALOGS";
        level = "catalogs";
      } else if (!input.schema) {
        sql = `SHOW SCHEMAS FROM "${input.catalog}"`;
        level = "schemas";
      } else {
        sql = `SHOW TABLES FROM "${input.catalog}"."${input.schema}"`;
        level = "tables";
      }
      const result = await executeQuery(sql, { maxRows: 500, timeoutMs: 10_000 });
      const items = result.rows.map((row) => row[0] as string);
      return { level, items, count: items.length };
    } catch (err) {
      if (err instanceof TrinoQueryError) {
        return { error: err.message, code: err.code };
      }
      return { error: (err as Error).message };
    }
  },
});

export const describeTableTool = tool({
  description:
    "Get column names, types, and other metadata for a table. " +
    "Use a fully qualified name like 'iceberg.schema_name.table_name'.",
  inputSchema: zodSchema(
    z.object({
      table: z
        .string()
        .describe(
          "Fully qualified table name (e.g. 'iceberg.ingest.page_views')",
        ),
    }),
  ),
  execute: async (input: { table: string }) => {
    try {
      const result = await executeQuery(`DESCRIBE ${input.table}`, {
        maxRows: 500,
        timeoutMs: 10_000,
      });
      const columns = result.rows.map((row) => ({
        name: row[0] as string,
        type: row[1] as string,
        extra: (row[2] as string) || undefined,
        comment: (row[3] as string) || undefined,
      }));
      return { table: input.table, columns, columnCount: columns.length };
    } catch (err) {
      if (err instanceof TrinoQueryError) {
        return { error: err.message, code: err.code };
      }
      return { error: (err as Error).message };
    }
  },
});

export const runQueryTool = tool({
  description:
    "Run a SQL query against Trino. Pass `sql` explicitly, or omit to use the SQL currently shown in the canvas editor. Read-only — DDL/DML is rejected for safety.",
  inputSchema: zodSchema(
    z.object({
      sql: z.string().optional().describe("SQL to run; omit to use canvas SQL."),
    }),
  ),
  execute: async (input) => ({
    stub: true,
    note: "Real implementation pending — needs spec-builder (~150 lines) + duckdb-client (~225 lines) + canvas-state mutation. Each is its own follow-up slice.",
    input,
    rows: [],
    columns: [],
  }),
});
