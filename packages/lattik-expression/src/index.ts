// AST types
export type {
  Expr,
  IntLiteral,
  FloatLiteral,
  StringLiteral,
  BoolLiteral,
  NullLiteral,
  ColumnRef,
  Star,
  BinaryExpr,
  BinaryOp,
  UnaryExpr,
  UnaryOp,
  BetweenExpr,
  InExpr,
  IsNullExpr,
  LikeExpr,
  CaseExpr,
  CaseWhen,
  CastExpr,
  FunctionCall,
  AggregateCall,
  WindowExpr,
  OrderByItem,
  WindowFrame,
  FrameBound,
  FrameBoundKind,
  FrameKind,
  Loc,
} from "./ast/nodes.js";

// Data types
export type { DataType, ScalarTypeKind } from "./ast/data-types.js";
export {
  dataType,
  isNumeric,
  isIntegral,
  isComparable,
  promoteNumeric,
  commonType,
  fromColumnType,
} from "./ast/data-types.js";

// Visitor utilities
export { walkExpr, mapExpr } from "./ast/visitor.js";

// Parser
export { parse, KNOWN_AGGREGATES } from "./parser/parse.js";
export type { ParseResult, ParseError } from "./parser/parse.js";

// Type checker
export { check, listFunctions } from "./checker/check.js";
export type { CheckResult, CheckError } from "./checker/check.js";
export type { SchemaContext, ColumnInfo, FunctionSignature } from "./checker/schema.js";

// SQL emitter
export { emitSql } from "./emitter/emit-sql.js";
export type { EmitOptions } from "./emitter/emit-sql.js";

// Limits
export { MAX_INPUT_LENGTH } from "./parser/lexer.js";
