import type { Classification } from "../../schema";
import { MOCK_DS, MOCK_FLOATS, MOCK_HOURS, MOCK_TIMESTAMPS } from "./constants";

export function toggleClassification(
  c: Classification | undefined,
  key: keyof Classification,
): Classification | undefined {
  const next: Classification = { ...(c ?? {}) };
  if (next[key]) delete next[key];
  else next[key] = true;
  return Object.keys(next).length > 0 ? next : undefined;
}

let _nextKey = 0;
export function genKey(prefix = "k"): string {
  return `${prefix}_${++_nextKey}_${Date.now()}`;
}

// Extract the identifier token at a given cursor position within a string.
// Returns { token, start, end } where start/end are character offsets.
export function tokenAtCursor(
  text: string,
  cursor: number,
): { token: string; start: number; end: number } {
  const before = text.slice(0, cursor);
  const match = before.match(/([a-z_][a-z0-9_]*)$/i);
  if (!match) return { token: "", start: cursor, end: cursor };
  const start = cursor - match[1].length;
  return { token: match[1].toLowerCase(), start, end: cursor };
}

export function mockValue(type: string, i: number, colName?: string): string {
  if (colName === "ds") return MOCK_DS[i % MOCK_DS.length];
  if (colName === "hour") return MOCK_HOURS[i % MOCK_HOURS.length];
  switch (type) {
    case "int32":
    case "int64":
      return String(1000 + i * 7);
    case "float":
    case "double":
      return MOCK_FLOATS[i % MOCK_FLOATS.length];
    case "boolean":
      return i % 2 === 0 ? "true" : "false";
    case "timestamp":
      return MOCK_TIMESTAMPS[i % MOCK_TIMESTAMPS.length];
    case "date":
      return MOCK_DS[i % MOCK_DS.length];
    case "json":
      return "{}";
    default:
      return `value_${i + 1}`;
  }
}
