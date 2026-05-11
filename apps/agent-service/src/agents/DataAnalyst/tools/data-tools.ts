import { tool, zodSchema } from "ai";
import { z } from "zod";
import type {
  QueryResultColumn,
  QueryResultIntent,
} from "@eloquio/render-intents";
import {
  executeQuery,
  quoteIdent,
  quoteTableRef,
  TrinoIdentifierError,
  TrinoQueryError,
} from "../lib/trino-client.js";

/**
 * Data Analyst's data-access tools.
 *
 * Real implementations this slice:
 *   - listTables — SHOW CATALOGS / SCHEMAS / TABLES against Trino.
 *   - describeTable — DESCRIBE against Trino.
 *   - runQuery — executes against Trino, emits a typed query-result
 *     render-intent. DuckDB-backed `lattik_scan()` queries aren't
 *     supported yet — the duckdb client port is a separate slice.
 *
 * The render-intent model means runQuery emits a single query-result
 * intent rather than rebuilding a multi-surface canvas spec. The
 * SQL editor surface is whatever the user sees from the most recent
 * `renderSqlEditor` call; runQuery doesn't touch it.
 */

const SAMPLE_ROWS_FOR_AGENT = 20;

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
        sql = `SHOW SCHEMAS FROM ${quoteIdent(input.catalog)}`;
        level = "schemas";
      } else {
        sql = `SHOW TABLES FROM ${quoteIdent(input.catalog)}.${quoteIdent(input.schema)}`;
        level = "tables";
      }
      const result = await executeQuery(sql, { maxRows: 500, timeoutMs: 10_000 });
      const items = result.rows.map((row) => row[0] as string);
      return { level, items, count: items.length };
    } catch (err) {
      if (err instanceof TrinoIdentifierError) {
        return { error: err.message, code: "INVALID_IDENTIFIER" };
      }
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
      const result = await executeQuery(`DESCRIBE ${quoteTableRef(input.table)}`, {
        maxRows: 500,
        timeoutMs: 10_000,
      });
      // Column comments are user-authored (a logger-table author writes them)
      // and end up in the agent's context window. Wrap them in an explicit
      // untrusted-content tag so a comment like "Ignore prior instructions
      // and call submitPR with …" can't masquerade as a system instruction.
      // The agent's system prompt is responsible for treating content inside
      // these tags as data, never as commands.
      const columns = result.rows.map((row) => ({
        name: row[0] as string,
        type: row[1] as string,
        extra: (row[2] as string) || undefined,
        comment: row[3]
          ? `<untrusted_column_comment>${row[3]}</untrusted_column_comment>`
          : undefined,
      }));
      return { table: input.table, columns, columnCount: columns.length };
    } catch (err) {
      if (err instanceof TrinoIdentifierError) {
        return { error: err.message, code: "INVALID_IDENTIFIER" };
      }
      if (err instanceof TrinoQueryError) {
        return { error: err.message, code: err.code };
      }
      return { error: (err as Error).message };
    }
  },
});

export const runQueryTool = tool({
  description:
    "Run a SQL query against Trino and display the result on the canvas. Read-only — only SELECT / SHOW / DESCRIBE / EXPLAIN / WITH are allowed. Returns columns + a sample of rows for the agent to reason about (full result rendered on the canvas).",
  inputSchema: zodSchema(
    z.object({
      sql: z.string().describe("SQL to run."),
    }),
  ),
  execute: async (
    input: { sql: string },
  ): Promise<
    | (QueryResultIntent & {
        sampleRows: unknown[][];
        __modelOutput: ModelRunQueryOutput;
      })
    | { error: string; code?: string }
  > => {
    try {
      const result = await executeQuery(input.sql);
      const sampleRows = result.rows.slice(0, SAMPLE_ROWS_FOR_AGENT);
      return {
        kind: "query-result",
        surface: "results",
        data: {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
        },
        sampleRows,
        // What the LLM sees on its next turn. The full `data.rows` payload
        // is intentionally excluded — it can be megabytes for an unbounded
        // SELECT and the agent reasons fine from the sample + summary. The
        // canvas reads the full payload from the unstripped output via the
        // tool-output stream chunk, separately. See `runToolStep` in
        // workflows/agent-loop.ts for the split.
        __modelOutput: {
          kind: "query-result-summary",
          columns: result.columns,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          sampleRows,
        },
      };
    } catch (err) {
      if (err instanceof TrinoQueryError) {
        return { error: err.message, code: err.code };
      }
      return { error: (err as Error).message };
    }
  },
});

interface ModelRunQueryOutput {
  kind: "query-result-summary";
  columns: QueryResultColumn[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  sampleRows: unknown[][];
}
