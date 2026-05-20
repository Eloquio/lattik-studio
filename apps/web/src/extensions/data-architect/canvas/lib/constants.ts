import type { ScalarTypeKind } from "@eloquio/lattik-expression";
import { KNOWN_AGGREGATES } from "@eloquio/lattik-expression";
import type { Classification } from "../../schema";

// Compliance flags shown on each column. Order here drives the popup pill
// order and the badge order on column rows, so keep it stable.
export const CLASSIFICATION_CATEGORIES: ReadonlyArray<{
  key: keyof Classification;
  label: string;
  badgeCls: string;
  pillActiveCls: string;
}> = [
  { key: "pii", label: "PII", badgeCls: "bg-red-100 text-red-600", pillActiveCls: "bg-red-100 text-red-600 ring-1 ring-red-200" },
  { key: "phi", label: "PHI", badgeCls: "bg-purple-100 text-purple-600", pillActiveCls: "bg-purple-100 text-purple-600 ring-1 ring-purple-200" },
  { key: "financial", label: "Financial", badgeCls: "bg-emerald-100 text-emerald-700", pillActiveCls: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200" },
  { key: "credentials", label: "Credentials", badgeCls: "bg-orange-100 text-orange-700", pillActiveCls: "bg-orange-100 text-orange-700 ring-1 ring-orange-200" },
];

export const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export const TYPE_OPTIONS: ScalarTypeKind[] = [
  "string",
  "int32",
  "int64",
  "float",
  "double",
  "boolean",
  "timestamp",
  "date",
  "json",
];

export const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500/30";

export const AGGREGATE_FUNCTIONS: string[] = Array.from(KNOWN_AGGREGATES);

// Function parameter templates: NAME (upper-case) → placeholder args
export const FN_PARAMS: Record<string, string[]> = {
  // Aggregates
  SUM: ["expr"], COUNT: [], AVG: ["expr"], MIN: ["expr"], MAX: ["expr"],
  FIRST: ["expr"], LAST: ["expr"], ANY_VALUE: ["expr"],
  COUNT_DISTINCT: ["expr"], COUNT_IF: ["condition"],
  SUM_IF: ["expr", "condition"], AVG_IF: ["expr", "condition"],
  COLLECT_LIST: ["expr"], COLLECT_SET: ["expr"],
  STDDEV: ["expr"], VARIANCE: ["expr"],
  PERCENTILE: ["col", "percentile"], PERCENTILE_APPROX: ["col", "accuracy"],
  APPROX_COUNT_DISTINCT: ["expr"],
  // Common scalar functions
  UPPER: ["str"], LOWER: ["str"], TRIM: ["str"], LENGTH: ["str"],
  COALESCE: ["expr1", "expr2"], ABS: ["num"], ROUND: ["num", "decimals"],
  SUBSTR: ["str", "start", "length"], CONCAT: ["str1", "str2"],
  CAST: ["expr"], IF: ["condition", "then", "else"],
};

export const SCALAR_FUNCTIONS = ["UPPER", "LOWER", "TRIM", "COALESCE", "ABS", "ROUND", "SUBSTR", "CONCAT", "LENGTH", "CAST", "IF"];

export const IMPLICIT_TOP = [
  { name: "event_id", type: "string", description: "Unique event identifier for deduplication" },
  { name: "event_timestamp", type: "timestamp", description: "When the event occurred" },
];

export const IMPLICIT_BOTTOM = [
  { name: "ds", type: "string", description: "Date partition key" },
  { name: "hour", type: "string", description: "Hour partition key" },
];

export const MOCK_TIMESTAMPS = ["2026-04-05T10:23:01", "2026-04-04T14:07:45", "2026-04-03T08:52:19"];
export const MOCK_FLOATS = ["42.17", "8.93", "71.56"];
export const MOCK_DS = ["2026-04-05", "2026-04-05", "2026-04-05"];
export const MOCK_HOURS = ["10", "10", "10"];

export const statusStyles: Record<string, { bg: string; text: string; dot: string }> = {
  draft: { bg: "bg-amber-100/50", text: "text-amber-700", dot: "bg-amber-400" },
  reviewing: { bg: "bg-blue-100/50", text: "text-blue-700", dot: "bg-blue-400" },
  "checks-passed": { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-400" },
  "checks-failed": { bg: "bg-red-100/50", text: "text-red-700", dot: "bg-red-400" },
  "pr-submitted": { bg: "bg-purple-100/50", text: "text-purple-700", dot: "bg-purple-400" },
  merged: { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-500" },
};
