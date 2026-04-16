/**
 * Emit an AST back to a SQL expression string.
 */

import type { Expr, BinaryOp, FrameBound } from "../ast/nodes.js";

export interface EmitOptions {
  /** Whether to pretty-print with indentation (default: false). */
  pretty?: boolean;
}

export function emitSql(expr: Expr, options?: EmitOptions): string {
  return new SqlEmitter(options?.pretty ?? false).emit(expr);
}

// ---------------------------------------------------------------------------
// Operator precedence (higher = binds tighter)
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<BinaryOp, number> = {
  OR: 1,
  AND: 2,
  "=": 3,
  "!=": 3,
  "<>": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "||": 4,
  "*": 5,
  "/": 5,
  "%": 5,
};

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP",
  "ALTER", "TABLE", "INDEX", "VIEW", "DATABASE", "SCHEMA", "GRANT", "REVOKE",
  "NULL", "TRUE", "FALSE", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE",
  "IS", "AS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "GROUP", "ORDER", "BY", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL",
  "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "CAST", "EXISTS",
  "ASC", "DESC", "OVER", "PARTITION", "ROWS", "RANGE", "UNBOUNDED",
  "PRECEDING", "FOLLOWING", "CURRENT", "ROW", "FILTER",
]);

class SqlEmitter {
  constructor(private pretty: boolean) {}

  emit(expr: Expr): string {
    switch (expr.kind) {
      case "IntLiteral":
        return expr.value;
      case "FloatLiteral":
        return expr.value;
      case "StringLiteral":
        return `'${expr.value.replace(/'/g, "''")}'`;
      case "BoolLiteral":
        return expr.value ? "TRUE" : "FALSE";
      case "NullLiteral":
        return "NULL";
      case "ColumnRef":
        return expr.table ? `${this.ident(expr.table)}.${this.ident(expr.column)}` : this.ident(expr.column);
      case "Star":
        return expr.table ? `${this.ident(expr.table)}.*` : "*";
      case "BinaryExpr":
        return this.emitBinary(expr);
      case "UnaryExpr":
        if (expr.op === "-") {
          return `-${this.emitWithParens(expr.operand, 6)}`;
        }
        return `NOT ${this.emitWithParens(expr.operand, 2)}`;
      case "BetweenExpr":
        return `${this.emit(expr.expr)} ${expr.negated ? "NOT BETWEEN" : "BETWEEN"} ${this.emit(expr.low)} AND ${this.emit(expr.high)}`;
      case "InExpr":
        return `${this.emit(expr.expr)} ${expr.negated ? "NOT IN" : "IN"} (${expr.values.map((v) => this.emit(v)).join(", ")})`;
      case "IsNullExpr":
        return `${this.emit(expr.expr)} IS ${expr.negated ? "NOT NULL" : "NULL"}`;
      case "LikeExpr":
        return `${this.emit(expr.expr)} ${expr.negated ? "NOT LIKE" : "LIKE"} ${this.emit(expr.pattern)}`;
      case "CaseExpr":
        return this.emitCase(expr);
      case "CastExpr":
        return `CAST(${this.emit(expr.expr)} AS ${expr.targetType.toUpperCase()})`;
      case "FunctionCall":
        return `${expr.name}(${expr.args.map((a) => this.emit(a)).join(", ")})`;
      case "AggregateCall":
        return this.emitAggregate(expr);
      case "WindowExpr":
        return this.emitWindow(expr);
    }
  }

  private emitBinary(expr: Expr & { kind: "BinaryExpr" }): string {
    const prec = PRECEDENCE[expr.op];
    const left = this.emitWithParens(expr.left, prec, "left");
    const right = this.emitWithParens(expr.right, prec, "right");
    return `${left} ${expr.op} ${right}`;
  }

  private emitWithParens(
    child: Expr,
    parentPrec: number,
    side?: "left" | "right"
  ): string {
    const sql = this.emit(child);
    if (child.kind === "BinaryExpr") {
      const childPrec = PRECEDENCE[child.op];
      // Parenthesize if child has lower precedence, or same precedence on right side
      if (childPrec < parentPrec || (childPrec === parentPrec && side === "right")) {
        return `(${sql})`;
      }
    }
    return sql;
  }

  private emitCase(expr: Expr & { kind: "CaseExpr" }): string {
    const parts: string[] = ["CASE"];
    if (expr.operand) parts.push(this.emit(expr.operand));
    for (const w of expr.whens) {
      parts.push(`WHEN ${this.emit(w.condition)} THEN ${this.emit(w.result)}`);
    }
    if (expr.elseResult) parts.push(`ELSE ${this.emit(expr.elseResult)}`);
    parts.push("END");
    return parts.join(" ");
  }

  private emitAggregate(expr: Expr & { kind: "AggregateCall" }): string {
    const distinct = expr.distinct ? "DISTINCT " : "";
    const args = expr.args.map((a) => this.emit(a)).join(", ");
    let sql = `${expr.name}(${distinct}${args})`;
    if (expr.filter) {
      sql += ` FILTER (WHERE ${this.emit(expr.filter)})`;
    }
    return sql;
  }

  private emitWindow(expr: Expr & { kind: "WindowExpr" }): string {
    const funcSql = this.emit(expr.func);
    const parts: string[] = [];

    if (expr.partitionBy.length > 0) {
      parts.push(`PARTITION BY ${expr.partitionBy.map((e) => this.emit(e)).join(", ")}`);
    }
    if (expr.orderBy.length > 0) {
      const items = expr.orderBy.map((o) => {
        let s = this.emit(o.expr);
        if (o.direction === "DESC") s += " DESC";
        if (o.nulls) s += ` NULLS ${o.nulls}`;
        return s;
      });
      parts.push(`ORDER BY ${items.join(", ")}`);
    }
    if (expr.frame) {
      const { type, start, end } = expr.frame;
      if (end) {
        parts.push(`${type} ${this.emitFrameBound(start)} AND ${this.emitFrameBound(end)}`);
      } else {
        parts.push(`${type} ${this.emitFrameBound(start)}`);
      }
    }

    return `${funcSql} OVER (${parts.join(" ")})`;
  }

  private emitFrameBound(bound: FrameBound): string {
    switch (bound.kind) {
      case "UNBOUNDED_PRECEDING":
        return "UNBOUNDED PRECEDING";
      case "UNBOUNDED_FOLLOWING":
        return "UNBOUNDED FOLLOWING";
      case "CURRENT_ROW":
        return "CURRENT ROW";
      case "PRECEDING":
        return `${bound.offset ? this.emit(bound.offset) : "1"} PRECEDING`;
      case "FOLLOWING":
        return `${bound.offset ? this.emit(bound.offset) : "1"} FOLLOWING`;
      default: {
        const _exhaustive: never = bound.kind;
        throw new Error(`Unknown frame bound kind: ${_exhaustive}`);
      }
    }
  }

  private ident(name: string): string {
    // Quote if the identifier contains special characters or is a keyword
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && !SQL_KEYWORDS.has(name.toUpperCase())) {
      return name;
    }
    // Escape double quotes inside identifiers by doubling them (SQL standard)
    return `"${name.replace(/"/g, '""')}"`;
  }
}
