import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stubs for Data Analyst's data-access tools. Real implementations
 * move from apps/web/src/extensions/data-analyst/tools/ in a follow-up
 * slice — they need a Trino client wired up in agent-service
 * (apps/agent-service/src/lib/trino-client.ts, not yet created).
 */

const noteStub = (note = "Real implementation pending — moves from apps/web in a follow-up slice.") =>
  ({ stub: true, note });

export const listTablesTool = tool({
  description:
    "List catalogs, schemas, and tables visible to the Trino query engine. Use this to discover what data is available.",
  inputSchema: zodSchema(
    z.object({
      catalog: z.string().optional().describe("Restrict to a single catalog (e.g. 'iceberg')."),
      schema: z.string().optional().describe("Restrict to a single schema."),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), input, tables: [] }),
});

export const describeTableTool = tool({
  description:
    "Describe a table's columns and types — fully-qualified table name (catalog.schema.table).",
  inputSchema: zodSchema(
    z.object({
      table: z.string().describe("Fully-qualified table name."),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), input, columns: [] }),
});

export const runQueryTool = tool({
  description:
    "Run a SQL query against Trino. Pass `sql` explicitly, or omit to use the SQL currently shown in the canvas editor. Read-only — DDL/DML is rejected for safety.",
  inputSchema: zodSchema(
    z.object({
      sql: z.string().optional().describe("SQL to run; omit to use canvas SQL."),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), input, rows: [], columns: [] }),
});
