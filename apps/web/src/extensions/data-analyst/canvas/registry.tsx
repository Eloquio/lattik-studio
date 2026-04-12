"use client";

import { useState, useMemo } from "react";
import { defineRegistry, useStateStore } from "@json-render/react";
import {
  BarChart as ReBarChart,
  Bar,
  LineChart as ReLineChart,
  Line,
  AreaChart as ReAreaChart,
  Area,
  PieChart as RePieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import CodeMirror from "@uiw/react-codemirror";
import { sql as sqlLanguage } from "@codemirror/lang-sql";
import { AlertCircle, ChevronLeft, ChevronRight, Table2 } from "lucide-react";
import { catalog } from "./catalog";

// ---- State helper ----
function useField<T = unknown>(field: string): [T, (v: T) => void] {
  const store = useStateStore();
  const value = store.get(`/${field}`) as T;
  const set = (v: T) => store.set(`/${field}`, v);
  return [value, set];
}

// ---- Chart colors ----
const CHART_COLORS = [
  "#e0a96e", // amber (accent)
  "#6ea5e0", // blue
  "#6ee0a9", // green
  "#e06e9a", // rose
  "#a96ee0", // purple
  "#e0d06e", // gold
  "#6ee0d0", // teal
  "#e08a6e", // orange
];

// ---- Shared styles ----
const cardCls =
  "rounded-lg border border-stone-200 bg-white shadow-sm overflow-hidden";
const headerCls =
  "flex items-center gap-2 border-b border-stone-100 bg-stone-50 px-4 py-2";
const headerTitleCls = "text-xs font-medium text-stone-600";

// ---- Helper: build row objects from columns + raw rows ----
function buildRowObjects(
  columns: { name: string }[],
  rows: unknown[][]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj;
  });
}

// ---- Components ----

function AnalystLayoutComponent({ children }: { children?: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function SqlEditorComponent() {
  const [sql, setSql] = useField<string>("sql");

  return (
    <div className={cardCls}>
      <div className={headerCls}>
        <Table2 className="h-3.5 w-3.5 text-stone-400" />
        <span className={headerTitleCls}>SQL Query</span>
      </div>
      <CodeMirror
        value={sql ?? ""}
        onChange={setSql}
        extensions={[sqlLanguage()]}
        theme="light"
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
        }}
        className="text-xs [&_.cm-editor]:!outline-none [&_.cm-gutters]:bg-stone-50 [&_.cm-gutters]:border-stone-200"
        minHeight="80px"
        maxHeight="300px"
      />
    </div>
  );
}

function QueryStatsComponent() {
  const [rowCount] = useField<number>("rowCount");
  const [duration] = useField<string>("duration");
  const [truncated] = useField<boolean>("truncated");

  return (
    <div className="flex items-center gap-3 px-1">
      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
        {rowCount?.toLocaleString() ?? 0} rows
      </span>
      {duration && (
        <span className="text-[11px] text-stone-400">{duration}</span>
      )}
      {truncated && (
        <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-700">
          Results truncated
        </span>
      )}
    </div>
  );
}

function QueryErrorComponent() {
  const [queryError] = useField<string>("queryError");

  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      <div>
        <p className="text-xs font-medium text-red-800">Query failed</p>
        <p className="mt-0.5 text-xs text-red-600 font-mono whitespace-pre-wrap">
          {queryError}
        </p>
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;

function ResultsTableComponent() {
  const [columns] = useField<{ name: string; type: string }[]>("columns");
  const [rows] = useField<unknown[][]>("rows");
  const [page, setPage] = useState(0);

  if (!columns?.length || !rows?.length) return null;

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className={cardCls}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50">
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium text-stone-600"
                >
                  {col.name}
                  <span className="ml-1 text-[10px] font-normal text-stone-400">
                    {col.type}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr
                key={ri}
                className="border-b border-stone-100 last:border-0 hover:bg-stone-50/50"
              >
                {columns.map((col, ci) => (
                  <td
                    key={col.name}
                    className="whitespace-nowrap px-3 py-1.5 text-stone-700 font-mono"
                  >
                    {row[ci] === null ? (
                      <span className="text-stone-300 italic">null</span>
                    ) : (
                      String(row[ci])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-stone-200 bg-stone-50 px-3 py-1.5">
          <span className="text-[11px] text-stone-500">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-1">
            <button
              className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600 disabled:opacity-30 disabled:hover:bg-transparent"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600 disabled:opacity-30 disabled:hover:bg-transparent"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Chart wrapper ----
function ChartWrapper({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className={cardCls}>
      {title && (
        <div className={headerCls}>
          <span className={headerTitleCls}>{title}</span>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

function useChartData() {
  const [columns] = useField<{ name: string; type: string }[]>("columns");
  const [rows] = useField<unknown[][]>("rows");
  const [chart] = useField<{
    type: string;
    title?: string;
    xColumn: string;
    yColumns: string[];
  }>("chart");

  const data = useMemo(() => {
    if (!columns || !rows || !chart) return [];
    return buildRowObjects(columns, rows);
  }, [columns, rows, chart]);

  return { data, chart, columns };
}

function BarChartComponent() {
  const { data, chart } = useChartData();
  if (!chart || !data.length) return null;

  return (
    <ChartWrapper title={chart.title}>
      <ResponsiveContainer width="100%" height={320}>
        <ReBarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis
            dataKey={chart.xColumn}
            tick={{ fontSize: 11 }}
            stroke="#a8a29e"
          />
          <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid #e7e5e4",
            }}
          />
          {chart.yColumns.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {chart.yColumns.map((col, i) => (
            <Bar
              key={col}
              dataKey={col}
              fill={CHART_COLORS[i % CHART_COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </ReBarChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function LineChartComponent() {
  const { data, chart } = useChartData();
  if (!chart || !data.length) return null;

  return (
    <ChartWrapper title={chart.title}>
      <ResponsiveContainer width="100%" height={320}>
        <ReLineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis
            dataKey={chart.xColumn}
            tick={{ fontSize: 11 }}
            stroke="#a8a29e"
          />
          <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid #e7e5e4",
            }}
          />
          {chart.yColumns.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {chart.yColumns.map((col, i) => (
            <Line
              key={col}
              type="monotone"
              dataKey={col}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          ))}
        </ReLineChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function AreaChartComponent() {
  const { data, chart } = useChartData();
  if (!chart || !data.length) return null;

  return (
    <ChartWrapper title={chart.title}>
      <ResponsiveContainer width="100%" height={320}>
        <ReAreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis
            dataKey={chart.xColumn}
            tick={{ fontSize: 11 }}
            stroke="#a8a29e"
          />
          <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid #e7e5e4",
            }}
          />
          {chart.yColumns.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {chart.yColumns.map((col, i) => (
            <Area
              key={col}
              type="monotone"
              dataKey={col}
              fill={CHART_COLORS[i % CHART_COLORS.length]}
              fillOpacity={0.2}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </ReAreaChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function PieChartComponent() {
  const { data, chart } = useChartData();
  if (!chart || !data.length) return null;

  // Pie uses the first yColumn as the value
  const valueKey = chart.yColumns[0];

  return (
    <ChartWrapper title={chart.title}>
      <ResponsiveContainer width="100%" height={320}>
        <RePieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={chart.xColumn}
            cx="50%"
            cy="50%"
            outerRadius={120}
            label={({ name, percent }) =>
              `${name ?? ""}: ${((percent ?? 0) * 100).toFixed(0)}%`
            }
            labelLine
            fontSize={11}
          >
            {data.map((_, i) => (
              <Cell
                key={i}
                fill={CHART_COLORS[i % CHART_COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid #e7e5e4",
            }}
          />
        </RePieChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function ScatterPlotComponent() {
  const { data, chart } = useChartData();
  if (!chart || !data.length) return null;

  const yKey = chart.yColumns[0];

  return (
    <ChartWrapper title={chart.title}>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis
            dataKey={chart.xColumn}
            name={chart.xColumn}
            tick={{ fontSize: 11 }}
            stroke="#a8a29e"
            type="number"
          />
          <YAxis
            dataKey={yKey}
            name={yKey}
            tick={{ fontSize: 11 }}
            stroke="#a8a29e"
            type="number"
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid #e7e5e4",
            }}
          />
          <Scatter data={data} fill={CHART_COLORS[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

// ---- Registry ----
export const { registry } = defineRegistry(catalog, {
  components: {
    AnalystLayout: ({ children }: { children?: React.ReactNode }) => (
      <AnalystLayoutComponent>{children}</AnalystLayoutComponent>
    ),
    SqlEditor: () => <SqlEditorComponent />,
    QueryStats: () => <QueryStatsComponent />,
    QueryError: () => <QueryErrorComponent />,
    ResultsTable: () => <ResultsTableComponent />,
    BarChart: () => <BarChartComponent />,
    LineChart: () => <LineChartComponent />,
    AreaChart: () => <AreaChartComponent />,
    PieChart: () => <PieChartComponent />,
    ScatterPlot: () => <ScatterPlotComponent />,
  },
});
