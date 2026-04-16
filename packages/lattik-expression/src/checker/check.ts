/**
 * Type checker for Lattik expressions.
 *
 * Bottom-up walk: resolves field references, infers types, reports errors.
 */

import type { DataType, ScalarTypeKind } from "../ast/data-types.js";
import {
  dataType,
  isNumeric,
  promoteNumeric,
  commonType,
  isComparable,
} from "../ast/data-types.js";
import type { Expr, Loc } from "../ast/nodes.js";
import { mapExpr } from "../ast/visitor.js";
import type { SchemaContext, FunctionSignature, ColumnInfo } from "./schema.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CheckError {
  loc?: Loc;
  code: string;
  message: string;
}

export interface CheckResult {
  /** AST with `dataType` populated on every node. */
  expr: Expr;
  errors: CheckError[];
}

export function check(expr: Expr, schema: SchemaContext): CheckResult {
  const checker = new TypeChecker(schema);
  const typed = checker.infer(expr);
  return { expr: typed, errors: checker.errors };
}

// ---------------------------------------------------------------------------
// Built-in aggregate return types
// ---------------------------------------------------------------------------

function aggregateReturnType(
  name: string,
  argType: DataType | null
): DataType {
  switch (name) {
    case "COUNT":
    case "COUNT_IF":
    case "APPROX_COUNT_DISTINCT":
      return dataType("int64", false);
    // SUM/SUM_IF: nullable because empty group returns NULL
    case "SUM":
    case "SUM_IF":
      if (argType && isNumeric(argType.scalar)) {
        const s = argType.scalar === "int32" ? "int64" : argType.scalar;
        return dataType(s, true);
      }
      return dataType("double", true);
    case "AVG":
    case "AVG_IF":
      return dataType("double", true);
    // MIN/MAX/FIRST/LAST: nullable because empty group returns NULL
    case "MIN":
    case "MAX":
    case "FIRST":
    case "LAST":
    case "ANY_VALUE":
      return dataType(argType?.scalar ?? "unknown", true);
    case "COLLECT_LIST":
    case "COLLECT_SET":
      return dataType("json", false);
    case "STDDEV":
    case "VARIANCE":
      return dataType("double", true);
    case "PERCENTILE":
    case "PERCENTILE_APPROX":
      return dataType("double", true);
    default:
      return dataType("unknown", true);
  }
}

// ---------------------------------------------------------------------------
// Built-in scalar functions
// ---------------------------------------------------------------------------

// Helper to define simple functions concisely
function fn(
  name: string,
  minArgs: number,
  maxArgs: number,
  resolve: (args: DataType[]) => DataType
): [string, FunctionSignature] {
  return [name, { name, minArgs, maxArgs, resolve }];
}

const passthrough = (args: DataType[]) => args[0] ?? dataType("unknown", false);
const returnsString = (args: DataType[]) => dataType("string", args[0]?.nullable ?? false);
const returnsInt = () => dataType("int32", false);
const returnsLong = () => dataType("int64", false);
const returnsDouble = (args: DataType[]) => dataType("double", args[0]?.nullable ?? false);
const returnsDoubleLit = () => dataType("double", false);
const returnsBool = () => dataType("boolean", false);
const returnsDate = () => dataType("date", false);
const returnsTimestamp = () => dataType("timestamp", false);
const returnsJson = () => dataType("json", false);

const BUILT_IN_FUNCTIONS: Map<string, FunctionSignature> = new Map([
  // --- Null handling ---
  fn("COALESCE", 1, Infinity, (args) => {
    let result: ScalarTypeKind = "null";
    for (const a of args) {
      const c = commonType(result, a.scalar);
      if (c) result = c;
    }
    return dataType(result, false);
  }),
  fn("NULLIF", 2, 2, (args) => dataType(args[0]?.scalar ?? "unknown", true)),
  fn("NVL", 2, 2, (args) => {
    const t = commonType(args[0]?.scalar ?? "unknown", args[1]?.scalar ?? "unknown");
    return dataType(t ?? "unknown", false);
  }),
  fn("NVL2", 3, 3, (args) => {
    const t = commonType(args[1]?.scalar ?? "unknown", args[2]?.scalar ?? "unknown");
    return dataType(t ?? "unknown", true);
  }),
  fn("IFNULL", 2, 2, (args) => {
    const t = commonType(args[0]?.scalar ?? "unknown", args[1]?.scalar ?? "unknown");
    return dataType(t ?? "unknown", false);
  }),
  fn("NANVL", 2, 2, (args) => args[0] ?? dataType("double", false)),
  fn("IF", 3, 3, (args) => {
    const t = commonType(args[1]?.scalar ?? "unknown", args[2]?.scalar ?? "unknown");
    return dataType(t ?? "unknown", true);
  }),

  // --- Math ---
  fn("ABS", 1, 1, passthrough),
  fn("CEIL", 1, 1, (args) => dataType(args[0]?.scalar ?? "int64", args[0]?.nullable ?? false)),
  fn("CEILING", 1, 1, (args) => dataType(args[0]?.scalar ?? "int64", args[0]?.nullable ?? false)),
  fn("FLOOR", 1, 1, (args) => dataType(args[0]?.scalar ?? "int64", args[0]?.nullable ?? false)),
  fn("ROUND", 1, 2, (args) => dataType(args[0]?.scalar ?? "double", args[0]?.nullable ?? false)),
  fn("BROUND", 1, 2, (args) => dataType(args[0]?.scalar ?? "double", args[0]?.nullable ?? false)),
  fn("POW", 2, 2, returnsDoubleLit),
  fn("POWER", 2, 2, returnsDoubleLit),
  fn("SQRT", 1, 1, returnsDouble),
  fn("CBRT", 1, 1, returnsDouble),
  fn("LOG", 1, 2, returnsDouble),
  fn("LOG2", 1, 1, returnsDouble),
  fn("LOG10", 1, 1, returnsDouble),
  fn("LN", 1, 1, returnsDouble),
  fn("EXP", 1, 1, returnsDouble),
  fn("SIGN", 1, 1, returnsDouble),
  fn("SIGNUM", 1, 1, returnsDouble),
  fn("MOD", 2, 2, passthrough),
  fn("PMOD", 2, 2, passthrough),
  fn("GREATEST", 2, Infinity, (args) => {
    let result: ScalarTypeKind = args[0]?.scalar ?? "unknown";
    for (const a of args.slice(1)) {
      const c = commonType(result, a.scalar);
      if (c) result = c;
    }
    return dataType(result, false);
  }),
  fn("LEAST", 2, Infinity, (args) => {
    let result: ScalarTypeKind = args[0]?.scalar ?? "unknown";
    for (const a of args.slice(1)) {
      const c = commonType(result, a.scalar);
      if (c) result = c;
    }
    return dataType(result, false);
  }),
  fn("RAND", 0, 1, returnsDoubleLit),
  fn("RANDN", 0, 1, returnsDoubleLit),
  fn("POSITIVE", 1, 1, passthrough),
  fn("NEGATIVE", 1, 1, passthrough),
  fn("DEGREES", 1, 1, returnsDouble),
  fn("RADIANS", 1, 1, returnsDouble),
  fn("SIN", 1, 1, returnsDouble),
  fn("COS", 1, 1, returnsDouble),
  fn("TAN", 1, 1, returnsDouble),
  fn("ASIN", 1, 1, returnsDouble),
  fn("ACOS", 1, 1, returnsDouble),
  fn("ATAN", 1, 1, returnsDouble),
  fn("ATAN2", 2, 2, returnsDoubleLit),
  fn("BIN", 1, 1, () => dataType("string", false)),
  fn("HEX", 1, 1, () => dataType("string", false)),
  fn("UNHEX", 1, 1, () => dataType("string", true)),
  fn("CONV", 3, 3, () => dataType("string", true)),

  // --- String ---
  fn("LENGTH", 1, 1, returnsInt),
  fn("CHAR_LENGTH", 1, 1, returnsInt),
  fn("CHARACTER_LENGTH", 1, 1, returnsInt),
  fn("BIT_LENGTH", 1, 1, returnsInt),
  fn("OCTET_LENGTH", 1, 1, returnsInt),
  fn("LOWER", 1, 1, returnsString),
  fn("LCASE", 1, 1, returnsString),
  fn("UPPER", 1, 1, returnsString),
  fn("UCASE", 1, 1, returnsString),
  fn("TRIM", 1, 3, returnsString),
  fn("LTRIM", 1, 2, returnsString),
  fn("RTRIM", 1, 2, returnsString),
  fn("LPAD", 2, 3, returnsString),
  fn("RPAD", 2, 3, returnsString),
  fn("REVERSE", 1, 1, returnsString),
  fn("INITCAP", 1, 1, returnsString),
  fn("TRANSLATE", 3, 3, returnsString),
  fn("REPLACE", 2, 3, returnsString),
  fn("REGEXP_REPLACE", 2, 3, returnsString),
  fn("REGEXP_EXTRACT", 2, 3, returnsString),
  fn("SPLIT", 2, 3, returnsJson),
  fn("CONCAT", 1, Infinity, () => dataType("string", false)),
  fn("CONCAT_WS", 2, Infinity, () => dataType("string", false)),
  fn("SUBSTRING", 2, 3, returnsString),
  fn("SUBSTR", 2, 3, returnsString),
  fn("LEFT", 2, 2, returnsString),
  fn("RIGHT", 2, 2, returnsString),
  fn("LOCATE", 2, 3, returnsInt),
  fn("INSTR", 2, 2, returnsInt),
  fn("FORMAT_NUMBER", 2, 2, () => dataType("string", false)),
  fn("REPEAT", 2, 2, returnsString),
  fn("OVERLAY", 3, 4, returnsString),
  fn("ENCODE", 2, 2, () => dataType("string", false)),
  fn("DECODE", 2, 2, () => dataType("string", false)),
  fn("ASCII", 1, 1, returnsInt),
  fn("CHR", 1, 1, () => dataType("string", false)),
  fn("BASE64", 1, 1, () => dataType("string", false)),
  fn("UNBASE64", 1, 1, () => dataType("string", false)),
  fn("SOUNDEX", 1, 1, () => dataType("string", false)),
  fn("LEVENSHTEIN", 2, 2, returnsInt),

  // --- Date/time ---
  fn("NOW", 0, 0, returnsTimestamp),
  fn("CURRENT_DATE", 0, 0, returnsDate),
  fn("CURRENT_TIMESTAMP", 0, 0, returnsTimestamp),
  fn("DATE_ADD", 2, 2, returnsDate),
  fn("DATE_SUB", 2, 2, returnsDate),
  fn("DATEDIFF", 2, 2, returnsInt),
  fn("MONTHS_BETWEEN", 2, 3, returnsDoubleLit),
  fn("ADD_MONTHS", 2, 2, returnsDate),
  fn("DATE_FORMAT", 2, 2, () => dataType("string", false)),
  fn("TO_DATE", 1, 2, () => dataType("date", true)),
  fn("TO_TIMESTAMP", 1, 2, () => dataType("timestamp", true)),
  fn("FROM_UNIXTIME", 1, 2, () => dataType("string", false)),
  fn("UNIX_TIMESTAMP", 0, 2, returnsLong),
  fn("YEAR", 1, 1, returnsInt),
  fn("MONTH", 1, 1, returnsInt),
  fn("DAY", 1, 1, returnsInt),
  fn("DAYOFMONTH", 1, 1, returnsInt),
  fn("HOUR", 1, 1, returnsInt),
  fn("MINUTE", 1, 1, returnsInt),
  fn("SECOND", 1, 1, returnsInt),
  fn("DAYOFWEEK", 1, 1, returnsInt),
  fn("DAYOFYEAR", 1, 1, returnsInt),
  fn("WEEKOFYEAR", 1, 1, returnsInt),
  fn("QUARTER", 1, 1, returnsInt),
  fn("LAST_DAY", 1, 1, returnsDate),
  fn("NEXT_DAY", 2, 2, returnsDate),
  fn("DATE_TRUNC", 2, 2, returnsTimestamp),
  fn("TRUNC", 1, 2, returnsDate),
  fn("MAKE_DATE", 3, 3, returnsDate),
  fn("MAKE_TIMESTAMP", 6, 7, returnsTimestamp),

  // --- Window functions ---
  fn("ROW_NUMBER", 0, 0, returnsLong),
  fn("RANK", 0, 0, returnsInt),
  fn("DENSE_RANK", 0, 0, returnsInt),
  fn("NTILE", 1, 1, returnsInt),
  fn("LAG", 1, 3, passthrough),
  fn("LEAD", 1, 3, passthrough),
  fn("FIRST_VALUE", 1, 2, passthrough),
  fn("LAST_VALUE", 1, 2, passthrough),
  fn("NTH_VALUE", 2, 2, passthrough),
  fn("CUME_DIST", 0, 0, returnsDoubleLit),
  fn("PERCENT_RANK", 0, 0, returnsDoubleLit),

  // --- Hash / crypto ---
  fn("HASH", 1, Infinity, returnsInt),
  fn("XXHASH64", 1, Infinity, returnsLong),
  fn("MD5", 1, 1, () => dataType("string", false)),
  fn("SHA1", 1, 1, () => dataType("string", false)),
  fn("SHA", 1, 1, () => dataType("string", false)),
  fn("SHA2", 2, 2, () => dataType("string", false)),
  fn("CRC32", 1, 1, returnsLong),

  // --- Array / complex ---
  fn("SIZE", 1, 1, returnsInt),
  fn("ARRAY_CONTAINS", 2, 2, returnsBool),
  fn("ARRAY_DISTINCT", 1, 1, returnsJson),
  fn("ARRAY_UNION", 2, 2, returnsJson),
  fn("ARRAY_INTERSECT", 2, 2, returnsJson),
  fn("ARRAY_EXCEPT", 2, 2, returnsJson),
  fn("ARRAY_JOIN", 2, 3, () => dataType("string", false)),
  fn("ARRAY_POSITION", 2, 2, returnsLong),
  fn("ARRAY_SORT", 1, 1, returnsJson),
  fn("FLATTEN", 1, 1, returnsJson),
  fn("SEQUENCE", 2, 3, returnsJson),
  fn("SORT_ARRAY", 1, 2, returnsJson),
  fn("SLICE", 3, 3, returnsJson),
  fn("ELEMENT_AT", 2, 2, (args) => args[0] ?? dataType("unknown", true)),
  fn("EXPLODE", 1, 1, (args) => args[0] ?? dataType("unknown", false)),
  fn("POSEXPLODE", 1, 1, (args) => args[0] ?? dataType("unknown", false)),
  fn("INLINE", 1, 1, (args) => args[0] ?? dataType("unknown", false)),

  // --- Map ---
  fn("MAP_KEYS", 1, 1, returnsJson),
  fn("MAP_VALUES", 1, 1, returnsJson),
  fn("MAP_FROM_ARRAYS", 2, 2, returnsJson),
  fn("MAP_CONCAT", 1, Infinity, returnsJson),
  fn("STR_TO_MAP", 1, 3, returnsJson),

  // --- JSON ---
  fn("GET_JSON_OBJECT", 2, 2, () => dataType("string", true)),
  fn("JSON_TUPLE", 2, Infinity, () => dataType("string", true)),
  fn("FROM_JSON", 2, 3, returnsJson),
  fn("TO_JSON", 1, 2, () => dataType("string", false)),
  fn("SCHEMA_OF_JSON", 1, 1, () => dataType("string", false)),

  // --- Type conversion ---
  fn("INT", 1, 1, () => dataType("int32", true)),
  fn("BIGINT", 1, 1, () => dataType("int64", true)),
  fn("FLOAT", 1, 1, () => dataType("float", true)),
  fn("DOUBLE", 1, 1, () => dataType("double", true)),
  fn("STRING", 1, 1, () => dataType("string", false)),
  fn("BOOLEAN", 1, 1, () => dataType("boolean", true)),
  fn("DATE", 1, 1, () => dataType("date", true)),
  fn("TIMESTAMP", 1, 1, () => dataType("timestamp", true)),
]);

/** All built-in scalar function names (upper-case), sorted. */
export function listFunctions(): string[] {
  return Array.from(BUILT_IN_FUNCTIONS.keys()).sort();
}

// ---------------------------------------------------------------------------
// Type checker
// ---------------------------------------------------------------------------

class TypeChecker {
  errors: CheckError[] = [];

  private columns: ColumnInfo[];
  private columnIndex: Map<string, ColumnInfo[]>;
  private functions: Map<string, FunctionSignature>;

  constructor(schema: SchemaContext) {
    this.columns = schema.columns;

    // Build column index for O(1) lookup by name
    this.columnIndex = new Map();
    for (const col of schema.columns) {
      const key = col.name.toLowerCase();
      const existing = this.columnIndex.get(key);
      if (existing) {
        existing.push(col);
      } else {
        this.columnIndex.set(key, [col]);
      }
    }

    // Reuse BUILT_IN_FUNCTIONS if no custom functions; avoid copying 140+ entries
    if (schema.functions && schema.functions.size > 0) {
      this.functions = new Map([...BUILT_IN_FUNCTIONS, ...schema.functions]);
    } else {
      this.functions = BUILT_IN_FUNCTIONS;
    }
  }

  infer(expr: Expr): Expr {
    return mapExpr(expr, (node) => this.inferNode(node));
  }

  private inferNode(node: Expr): Expr {
    switch (node.kind) {
      case "IntLiteral":
        return { ...node, dataType: dataType("int64", false) };
      case "FloatLiteral":
        return { ...node, dataType: dataType("double", false) };
      case "StringLiteral":
        return { ...node, dataType: dataType("string", false) };
      case "BoolLiteral":
        return { ...node, dataType: dataType("boolean", false) };
      case "NullLiteral":
        return { ...node, dataType: dataType("null", true) };
      case "Star":
        return { ...node, dataType: dataType("int64", false) };
      case "ColumnRef":
        return this.inferColumnRef(node);
      case "BinaryExpr":
        return this.inferBinary(node);
      case "UnaryExpr":
        return this.inferUnary(node);
      case "BetweenExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "InExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "IsNullExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "LikeExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "CaseExpr":
        return this.inferCase(node);
      case "CastExpr":
        return { ...node, dataType: dataType(node.targetType, node.expr.dataType?.nullable ?? false) };
      case "FunctionCall":
        return this.inferFunction(node);
      case "AggregateCall":
        return this.inferAggregate(node);
      case "WindowExpr":
        return { ...node, dataType: node.func.dataType };
    }
  }

  private inferColumnRef(node: Expr & { kind: "ColumnRef" }): Expr {
    const match = this.resolveColumn(node.table, node.column);
    if (!match) {
      const ref = node.table ? `${node.table}.${node.column}` : node.column;
      this.errors.push({
        loc: node.loc,
        code: "UNKNOWN_COLUMN",
        message: `Unknown column '${ref}'`,
      });
      return { ...node, dataType: dataType("unknown", true) };
    }
    return { ...node, dataType: match.dataType };
  }

  private resolveColumn(
    table: string | undefined,
    column: string
  ): ColumnInfo | null {
    const candidates = this.columnIndex.get(column.toLowerCase());
    if (!candidates || candidates.length === 0) return null;

    const matches = table
      ? candidates.filter((c) => !c.table || c.table === table)
      : candidates;

    if (matches.length === 0) return null;
    if (matches.length > 1 && !table) {
      this.errors.push({
        code: "AMBIGUOUS_COLUMN",
        message: `Ambiguous column '${column}' — qualify with table name`,
      });
    }
    return matches[0];
  }

  private inferBinary(node: Expr & { kind: "BinaryExpr" }): Expr {
    const lt = node.left.dataType;
    const rt = node.right.dataType;
    const nullable = (lt?.nullable ?? false) || (rt?.nullable ?? false);

    switch (node.op) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "%": {
        if (lt && rt && lt.scalar !== "null" && rt.scalar !== "null") {
          const promoted = promoteNumeric(lt.scalar, rt.scalar);
          if (promoted === null) {
            this.errors.push({
              loc: node.loc,
              code: "TYPE_MISMATCH",
              message: `Cannot apply '${node.op}' to ${lt.scalar} and ${rt.scalar}`,
            });
            return { ...node, dataType: dataType("unknown", nullable) };
          }
          return { ...node, dataType: dataType(promoted, nullable) };
        }
        return { ...node, dataType: dataType("unknown", nullable) };
      }
      case "||":
        return { ...node, dataType: dataType("string", nullable) };
      case "=":
      case "!=":
      case "<>":
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (
          lt &&
          rt &&
          lt.scalar !== "null" &&
          rt.scalar !== "null" &&
          lt.scalar !== "unknown" &&
          rt.scalar !== "unknown"
        ) {
          if (!isComparable(lt.scalar) || !isComparable(rt.scalar)) {
            this.errors.push({
              loc: node.loc,
              code: "TYPE_MISMATCH",
              message: `Cannot compare ${lt.scalar} and ${rt.scalar}`,
            });
          }
        }
        return { ...node, dataType: dataType("boolean", false) };
      }
      case "AND":
      case "OR":
        return { ...node, dataType: dataType("boolean", false) };
    }
  }

  private inferUnary(node: Expr & { kind: "UnaryExpr" }): Expr {
    if (node.op === "-") {
      const t = node.operand.dataType;
      if (t && t.scalar !== "null" && t.scalar !== "unknown" && !isNumeric(t.scalar)) {
        this.errors.push({
          loc: node.loc,
          code: "TYPE_MISMATCH",
          message: `Cannot apply unary '-' to ${t.scalar}`,
        });
      }
      return { ...node, dataType: node.operand.dataType };
    }
    // NOT
    return { ...node, dataType: dataType("boolean", false) };
  }

  private inferCase(node: Expr & { kind: "CaseExpr" }): Expr {
    let resultType: ScalarTypeKind = "null";
    let nullable = false;

    for (const w of node.whens) {
      const t = w.result.dataType;
      if (t) {
        const c = commonType(resultType, t.scalar);
        if (c === null) {
          this.errors.push({
            loc: node.loc,
            code: "TYPE_MISMATCH",
            message: `Incompatible CASE branch types: ${resultType} and ${t.scalar}`,
          });
        } else {
          resultType = c;
        }
        nullable = nullable || t.nullable;
      }
    }

    if (node.elseResult?.dataType) {
      const c = commonType(resultType, node.elseResult.dataType.scalar);
      if (c !== null) resultType = c;
      nullable = nullable || node.elseResult.dataType.nullable;
    } else {
      // No ELSE means result can be null
      nullable = true;
    }

    return { ...node, dataType: dataType(resultType, nullable) };
  }

  private inferFunction(node: Expr & { kind: "FunctionCall" }): Expr {
    const sig = this.functions.get(node.name);
    if (!sig) {
      this.errors.push({
        loc: node.loc,
        code: "UNKNOWN_FUNCTION",
        message: `Unknown function '${node.name}'`,
      });
      return { ...node, dataType: dataType("unknown", true) };
    }
    if (node.args.length < sig.minArgs || node.args.length > sig.maxArgs) {
      this.errors.push({
        loc: node.loc,
        code: "ARG_COUNT",
        message: `${node.name} expects ${sig.minArgs === sig.maxArgs ? sig.minArgs : `${sig.minArgs}-${sig.maxArgs}`} arguments, got ${node.args.length}`,
      });
    }
    const argTypes = node.args
      .map((a) => a.dataType)
      .filter((t): t is DataType => t !== undefined);
    const resolved = sig.resolve(argTypes);
    return { ...node, dataType: resolved };
  }

  private inferAggregate(node: Expr & { kind: "AggregateCall" }): Expr {
    const argType =
      node.args.length > 0 && node.args[0].kind !== "Star"
        ? node.args[0].dataType ?? null
        : null;

    // Validate conditional aggregates
    switch (node.name) {
      case "COUNT_IF":
        if (node.args.length !== 1) {
          this.errors.push({
            loc: node.loc,
            code: "ARG_COUNT",
            message: `COUNT_IF expects 1 argument, got ${node.args.length}`,
          });
        } else if (
          argType &&
          argType.scalar !== "boolean" &&
          argType.scalar !== "null" &&
          argType.scalar !== "unknown"
        ) {
          this.errors.push({
            loc: node.loc,
            code: "TYPE_MISMATCH",
            message: `COUNT_IF argument should be boolean, got ${argType.scalar}`,
          });
        }
        break;
      case "SUM_IF":
      case "AVG_IF": {
        if (node.args.length !== 2) {
          this.errors.push({
            loc: node.loc,
            code: "ARG_COUNT",
            message: `${node.name} expects 2 arguments, got ${node.args.length}`,
          });
        } else {
          const condType = node.args[1].dataType;
          if (
            condType &&
            condType.scalar !== "boolean" &&
            condType.scalar !== "null" &&
            condType.scalar !== "unknown"
          ) {
            this.errors.push({
              loc: node.loc,
              code: "TYPE_MISMATCH",
              message: `${node.name} condition argument should be boolean, got ${condType.scalar}`,
            });
          }
        }
        break;
      }
    }

    // Validate filter clause is boolean
    if (node.filter) {
      const filterType = node.filter.dataType;
      if (
        filterType &&
        filterType.scalar !== "boolean" &&
        filterType.scalar !== "null" &&
        filterType.scalar !== "unknown"
      ) {
        this.errors.push({
          loc: node.filter.loc,
          code: "TYPE_MISMATCH",
          message: `FILTER clause must be boolean, got ${filterType.scalar}`,
        });
      }
    }

    const dt = aggregateReturnType(node.name, argType);
    return { ...node, dataType: dt };
  }
}
