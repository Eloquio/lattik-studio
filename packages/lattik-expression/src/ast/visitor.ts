/**
 * Generic visitor and transformer for Lattik expression ASTs.
 */

import type { Expr } from "./nodes.js";

/**
 * Walk an expression tree, calling `visit` on each node.
 * `visit` receives the node and a function to recurse into children.
 */
export function walkExpr(
  expr: Expr,
  visit: (node: Expr, recurse: () => void) => void
): void {
  visit(expr, () => {
    switch (expr.kind) {
      case "IntLiteral":
      case "FloatLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NullLiteral":
      case "ColumnRef":
      case "Star":
        break;
      case "BinaryExpr":
        walkExpr(expr.left, visit);
        walkExpr(expr.right, visit);
        break;
      case "UnaryExpr":
        walkExpr(expr.operand, visit);
        break;
      case "BetweenExpr":
        walkExpr(expr.expr, visit);
        walkExpr(expr.low, visit);
        walkExpr(expr.high, visit);
        break;
      case "InExpr":
        walkExpr(expr.expr, visit);
        for (const v of expr.values) walkExpr(v, visit);
        break;
      case "IsNullExpr":
        walkExpr(expr.expr, visit);
        break;
      case "LikeExpr":
        walkExpr(expr.expr, visit);
        walkExpr(expr.pattern, visit);
        break;
      case "CaseExpr":
        if (expr.operand) walkExpr(expr.operand, visit);
        for (const w of expr.whens) {
          walkExpr(w.condition, visit);
          walkExpr(w.result, visit);
        }
        if (expr.elseResult) walkExpr(expr.elseResult, visit);
        break;
      case "CastExpr":
        walkExpr(expr.expr, visit);
        break;
      case "FunctionCall":
        for (const a of expr.args) walkExpr(a, visit);
        break;
      case "AggregateCall":
        for (const a of expr.args) walkExpr(a, visit);
        if (expr.filter) walkExpr(expr.filter, visit);
        break;
      case "WindowExpr":
        walkExpr(expr.func, visit);
        for (const p of expr.partitionBy) walkExpr(p, visit);
        for (const o of expr.orderBy) walkExpr(o.expr, visit);
        if (expr.frame?.start.offset) walkExpr(expr.frame.start.offset, visit);
        if (expr.frame?.end?.offset) walkExpr(expr.frame.end.offset, visit);
        break;
    }
  });
}

/**
 * Transform an expression tree bottom-up.
 * `transform` receives a node (with children already transformed)
 * and returns a replacement node.
 */
export function mapExpr(
  expr: Expr,
  transform: (node: Expr) => Expr
): Expr {
  const mapped = mapChildren(expr, transform);
  return transform(mapped);
}

function mapChildren(
  expr: Expr,
  transform: (node: Expr) => Expr
): Expr {
  const m = (e: Expr) => mapExpr(e, transform);

  switch (expr.kind) {
    case "IntLiteral":
    case "FloatLiteral":
    case "StringLiteral":
    case "BoolLiteral":
    case "NullLiteral":
    case "ColumnRef":
    case "Star":
      return expr;
    case "BinaryExpr":
      return { ...expr, left: m(expr.left), right: m(expr.right) };
    case "UnaryExpr":
      return { ...expr, operand: m(expr.operand) };
    case "BetweenExpr":
      return { ...expr, expr: m(expr.expr), low: m(expr.low), high: m(expr.high) };
    case "InExpr":
      return { ...expr, expr: m(expr.expr), values: expr.values.map(m) };
    case "IsNullExpr":
      return { ...expr, expr: m(expr.expr) };
    case "LikeExpr":
      return { ...expr, expr: m(expr.expr), pattern: m(expr.pattern) };
    case "CaseExpr":
      return {
        ...expr,
        operand: expr.operand ? m(expr.operand) : undefined,
        whens: expr.whens.map((w) => ({
          condition: m(w.condition),
          result: m(w.result),
        })),
        elseResult: expr.elseResult ? m(expr.elseResult) : undefined,
      };
    case "CastExpr":
      return { ...expr, expr: m(expr.expr) };
    case "FunctionCall":
      return { ...expr, args: expr.args.map(m) };
    case "AggregateCall":
      return {
        ...expr,
        args: expr.args.map(m),
        filter: expr.filter ? m(expr.filter) : undefined,
      };
    case "WindowExpr":
      return {
        ...expr,
        func: m(expr.func) as typeof expr.func,
        partitionBy: expr.partitionBy.map(m),
        orderBy: expr.orderBy.map((o) => ({ ...o, expr: m(o.expr) })),
        frame: expr.frame
          ? {
              ...expr.frame,
              start: {
                ...expr.frame.start,
                offset: expr.frame.start.offset
                  ? m(expr.frame.start.offset)
                  : undefined,
              },
              end: expr.frame.end
                ? {
                    ...expr.frame.end,
                    offset: expr.frame.end.offset
                      ? m(expr.frame.end.offset)
                      : undefined,
                  }
                : undefined,
            }
          : undefined,
      };
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}
