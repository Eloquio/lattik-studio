/**
 * AST node definitions for Lattik expressions.
 *
 * Discriminated union on `kind`. Every node carries:
 * - `loc?` — source position (set by parser)
 * - `dataType?` — resolved type (set by type checker)
 */

import type { DataType, ScalarTypeKind } from "./data-types.js";

// ---------------------------------------------------------------------------
// Source location
// ---------------------------------------------------------------------------

export interface Loc {
  startLine: number;
  startCol: number;
  stopLine: number;
  stopCol: number;
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

interface ExprBase {
  loc?: Loc;
  dataType?: DataType;
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export interface IntLiteral extends ExprBase {
  kind: "IntLiteral";
  /** String representation to avoid int64 precision loss in JSON. */
  value: string;
}

export interface FloatLiteral extends ExprBase {
  kind: "FloatLiteral";
  value: string;
}

export interface StringLiteral extends ExprBase {
  kind: "StringLiteral";
  value: string;
}

export interface BoolLiteral extends ExprBase {
  kind: "BoolLiteral";
  value: boolean;
}

export interface NullLiteral extends ExprBase {
  kind: "NullLiteral";
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface ColumnRef extends ExprBase {
  kind: "ColumnRef";
  table?: string;
  column: string;
}

/** Used only inside COUNT(*). */
export interface Star extends ExprBase {
  kind: "Star";
  table?: string;
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type BinaryOp =
  // arithmetic
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  // string concat
  | "||"
  // comparison
  | "="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  // logical
  | "AND"
  | "OR";

export type UnaryOp = "-" | "NOT";

export interface BinaryExpr extends ExprBase {
  kind: "BinaryExpr";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends ExprBase {
  kind: "UnaryExpr";
  op: UnaryOp;
  operand: Expr;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export interface BetweenExpr extends ExprBase {
  kind: "BetweenExpr";
  expr: Expr;
  low: Expr;
  high: Expr;
  negated: boolean;
}

export interface InExpr extends ExprBase {
  kind: "InExpr";
  expr: Expr;
  values: Expr[];
  negated: boolean;
}

export interface IsNullExpr extends ExprBase {
  kind: "IsNullExpr";
  expr: Expr;
  negated: boolean;
}

export interface LikeExpr extends ExprBase {
  kind: "LikeExpr";
  expr: Expr;
  pattern: Expr;
  negated: boolean;
}

// ---------------------------------------------------------------------------
// CASE / CAST
// ---------------------------------------------------------------------------

export interface CaseWhen {
  condition: Expr;
  result: Expr;
}

export interface CaseExpr extends ExprBase {
  kind: "CaseExpr";
  /** Present for simple CASE (CASE x WHEN ...). */
  operand?: Expr;
  whens: CaseWhen[];
  elseResult?: Expr;
}

export interface CastExpr extends ExprBase {
  kind: "CastExpr";
  expr: Expr;
  targetType: ScalarTypeKind;
}

// ---------------------------------------------------------------------------
// Function calls
// ---------------------------------------------------------------------------

export interface FunctionCall extends ExprBase {
  kind: "FunctionCall";
  /** Uppercase-normalized function name. */
  name: string;
  args: Expr[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregateCall extends ExprBase {
  kind: "AggregateCall";
  /** Uppercase-normalized: SUM, COUNT, AVG, MIN, MAX, etc. */
  name: string;
  args: Expr[];
  distinct?: boolean;
  filter?: Expr;
}

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

export interface OrderByItem {
  expr: Expr;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

export type FrameKind = "ROWS" | "RANGE";

export type FrameBoundKind =
  | "UNBOUNDED_PRECEDING"
  | "CURRENT_ROW"
  | "UNBOUNDED_FOLLOWING"
  | "PRECEDING"
  | "FOLLOWING";

export interface FrameBound {
  kind: FrameBoundKind;
  offset?: Expr;
}

export interface WindowFrame {
  type: FrameKind;
  start: FrameBound;
  end?: FrameBound;
}

export interface WindowExpr extends ExprBase {
  kind: "WindowExpr";
  func: AggregateCall | FunctionCall;
  partitionBy: Expr[];
  orderBy: OrderByItem[];
  frame?: WindowFrame;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type Expr =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | NullLiteral
  | ColumnRef
  | Star
  | BinaryExpr
  | UnaryExpr
  | BetweenExpr
  | InExpr
  | IsNullExpr
  | LikeExpr
  | CaseExpr
  | CastExpr
  | FunctionCall
  | AggregateCall
  | WindowExpr;
