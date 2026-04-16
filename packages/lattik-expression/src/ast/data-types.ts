/**
 * Data type system for Lattik expressions.
 *
 * Aligned with COLUMN_TYPES from the data-architect schema:
 * string, int32, int64, float, double, boolean, timestamp, date, json
 */

export type ScalarTypeKind =
  | "string"
  | "int32"
  | "int64"
  | "float"
  | "double"
  | "boolean"
  | "timestamp"
  | "date"
  | "json"
  | "null"
  | "unknown";

export interface DataType {
  scalar: ScalarTypeKind;
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function dataType(
  scalar: ScalarTypeKind,
  nullable = false
): DataType {
  return { scalar, nullable };
}

const NUMERIC_TYPES: ReadonlySet<ScalarTypeKind> = new Set([
  "int32",
  "int64",
  "float",
  "double",
]);

const INTEGRAL_TYPES: ReadonlySet<ScalarTypeKind> = new Set([
  "int32",
  "int64",
]);

/** Numeric promotion order (lower index = narrower). */
const NUMERIC_RANK: Record<string, number> = {
  int32: 0,
  int64: 1,
  float: 2,
  double: 3,
};

export function isNumeric(t: ScalarTypeKind): boolean {
  return NUMERIC_TYPES.has(t);
}

export function isIntegral(t: ScalarTypeKind): boolean {
  return INTEGRAL_TYPES.has(t);
}

export function isComparable(t: ScalarTypeKind): boolean {
  return t !== "json" && t !== "unknown";
}

/**
 * Return the wider of two numeric types following promotion rules.
 * Returns `null` if either type is not numeric.
 */
export function promoteNumeric(
  a: ScalarTypeKind,
  b: ScalarTypeKind
): ScalarTypeKind | null {
  const ra = NUMERIC_RANK[a];
  const rb = NUMERIC_RANK[b];
  if (ra === undefined || rb === undefined) return null;
  return ra >= rb ? a : b;
}

/**
 * Find a common type for two types (e.g. CASE branch unification).
 * Returns `null` if the types are incompatible.
 */
export function commonType(
  a: ScalarTypeKind,
  b: ScalarTypeKind
): ScalarTypeKind | null {
  if (a === b) return a;
  if (a === "null") return b;
  if (b === "null") return a;
  if (a === "unknown" || b === "unknown") return "unknown";

  // numeric promotion
  const promoted = promoteNumeric(a, b);
  if (promoted !== null) return promoted;

  // timestamp and date can unify to timestamp
  if (
    (a === "timestamp" && b === "date") ||
    (a === "date" && b === "timestamp")
  ) {
    return "timestamp";
  }

  return null;
}

/**
 * Map a column type string (from the schema) to a ScalarTypeKind.
 */
export function fromColumnType(s: string): ScalarTypeKind {
  const normalized = s.toLowerCase();
  if (
    normalized === "string" ||
    normalized === "int32" ||
    normalized === "int64" ||
    normalized === "float" ||
    normalized === "double" ||
    normalized === "boolean" ||
    normalized === "timestamp" ||
    normalized === "date" ||
    normalized === "json"
  ) {
    return normalized;
  }
  return "unknown";
}
