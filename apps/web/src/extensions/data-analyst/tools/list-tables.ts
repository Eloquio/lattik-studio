import { zodSchema } from "ai";
import { z } from "zod";
import { executeQuery, TrinoQueryError } from "../lib/trino-client";

export const listTablesTool = {
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
    })
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
};
