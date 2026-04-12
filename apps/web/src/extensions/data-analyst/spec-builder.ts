import type { Spec } from "@json-render/core";
import type { TrinoColumn } from "./lib/trino-client";

/**
 * Canvas state shape for the Data Analyst extension.
 *
 * Each field is optional — the spec builder only includes panels for fields
 * that have data. Tools progressively populate this state:
 *   1. renderSqlEditor → sets `sql`
 *   2. runQuery → sets `sql`, `columns`, `rows`, `queryStatus`, `duration`, `rowCount`
 *   3. renderChart → sets `chart`
 */
export interface AnalystCanvasState {
  sql?: string;
  columns?: TrinoColumn[];
  rows?: unknown[][];
  queryStatus?: "success" | "error";
  queryError?: string;
  duration?: string;
  rowCount?: number;
  truncated?: boolean;
  chart?: ChartConfig;
  /** Panel visibility — all default to true when data exists */
  showSql?: boolean;
  showResults?: boolean;
  showChart?: boolean;
}

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter";

export interface ChartConfig {
  type: ChartType;
  title?: string;
  xColumn: string;
  yColumns: string[];
}

/**
 * Deterministic spec builder for the Data Analyst canvas.
 *
 * Takes the full analyst state and produces a json-render Spec with all
 * visible panels. Panels without data are omitted from the layout's children.
 * Each tool reads current canvas state, merges in its data, and calls this
 * builder to produce a complete replacement spec.
 */
export function buildAnalystCanvasSpec(state: AnalystCanvasState): Spec {
  const children: string[] = [];
  const elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }> = {};

  const showSql = state.showSql !== false;
  const showResults = state.showResults !== false;
  const showChart = state.showChart !== false;

  // SQL Editor
  if (state.sql !== undefined && showSql) {
    children.push("sql-editor");
    elements["sql-editor"] = { type: "SqlEditor", props: {} };
  }

  // Query Stats + Results Table
  if (state.queryStatus === "success" && state.columns && state.rows) {
    children.push("query-stats");
    elements["query-stats"] = { type: "QueryStats", props: {} };

    if (showResults) {
      children.push("results-table");
      elements["results-table"] = { type: "ResultsTable", props: {} };
    }
  }

  // Query error
  if (state.queryStatus === "error" && state.queryError) {
    children.push("query-error");
    elements["query-error"] = { type: "QueryError", props: {} };
  }

  // Chart
  if (state.chart && state.columns && state.rows && showChart) {
    const chartComponentType = chartTypeToComponent(state.chart.type);
    children.push("chart-container");
    elements["chart-container"] = {
      type: chartComponentType,
      props: {},
    };
  }

  elements["layout"] = {
    type: "AnalystLayout",
    props: {},
    children,
  };

  return {
    root: "layout",
    elements,
    state: {
      sql: state.sql ?? "",
      columns: state.columns ?? [],
      rows: state.rows ?? [],
      queryStatus: state.queryStatus ?? null,
      queryError: state.queryError ?? null,
      duration: state.duration ?? null,
      rowCount: state.rowCount ?? 0,
      truncated: state.truncated ?? false,
      chart: state.chart ?? null,
      showSql: state.showSql ?? true,
      showResults: state.showResults ?? true,
      showChart: state.showChart ?? true,
    },
  };
}

function chartTypeToComponent(type: ChartType): string {
  switch (type) {
    case "bar":
      return "BarChart";
    case "line":
      return "LineChart";
    case "area":
      return "AreaChart";
    case "pie":
      return "PieChart";
    case "scatter":
      return "ScatterPlot";
  }
}

/**
 * Extract AnalystCanvasState from a raw canvasState object (as stored in DB).
 * Falls back to empty state for any missing fields.
 */
export function extractAnalystState(canvasState: unknown): AnalystCanvasState {
  if (!canvasState || typeof canvasState !== "object") return {};
  const spec = canvasState as Record<string, unknown>;
  const state = (spec.state ?? {}) as Record<string, unknown>;
  return {
    sql: typeof state.sql === "string" ? state.sql : undefined,
    columns: Array.isArray(state.columns) ? state.columns as TrinoColumn[] : undefined,
    rows: Array.isArray(state.rows) ? state.rows as unknown[][] : undefined,
    queryStatus: state.queryStatus === "success" || state.queryStatus === "error" ? state.queryStatus : undefined,
    queryError: typeof state.queryError === "string" ? state.queryError : undefined,
    duration: typeof state.duration === "string" ? state.duration : undefined,
    rowCount: typeof state.rowCount === "number" ? state.rowCount : undefined,
    truncated: typeof state.truncated === "boolean" ? state.truncated : undefined,
    chart: state.chart && typeof state.chart === "object" ? state.chart as ChartConfig : undefined,
    showSql: typeof state.showSql === "boolean" ? state.showSql : undefined,
    showResults: typeof state.showResults === "boolean" ? state.showResults : undefined,
    showChart: typeof state.showChart === "boolean" ? state.showChart : undefined,
  };
}
