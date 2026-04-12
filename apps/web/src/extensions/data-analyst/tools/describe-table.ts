import { zodSchema } from "ai";
import { z } from "zod";
import { executeQuery, TrinoQueryError } from "../lib/trino-client";

export const describeTableTool = {
  description:
    "Get column names, types, and other metadata for a table. " +
    "Use a fully qualified name like 'iceberg.schema_name.table_name'.",
  inputSchema: zodSchema(
    z.object({
      table: z
        .string()
        .describe(
          "Fully qualified table name (e.g. 'iceberg.ingest.page_views')"
        ),
    })
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
};
