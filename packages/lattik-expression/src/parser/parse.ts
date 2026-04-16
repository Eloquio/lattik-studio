/**
 * Recursive descent parser for Lattik SQL expressions.
 *
 * Grammar (precedence low→high):
 *   expr        → or_expr
 *   or_expr     → and_expr (OR and_expr)*
 *   and_expr    → not_expr (AND not_expr)*
 *   not_expr    → NOT not_expr | comparison
 *   comparison  → addition (comp_op addition | IS [NOT] NULL | [NOT] BETWEEN addition AND addition | [NOT] IN '(' expr_list ')' | [NOT] LIKE addition)?
 *   addition    → multiply ((+ | - | ||) multiply)*
 *   multiply    → unary ((* | / | %) unary)*
 *   unary       → - unary | primary
 *   primary     → literal | function_call_or_col_ref | '(' expr ')' | CASE ... END | CAST(...)
 */

import type {
  Expr,
  BinaryOp,
  Loc,
  OrderByItem,
  WindowFrame,
  FrameBound,
  AggregateCall,
  FunctionCall,
} from "../ast/nodes.js";
import type { ScalarTypeKind } from "../ast/data-types.js";
import { tokenize, type Token, type TokenKind } from "./lexer.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseError {
  line: number;
  col: number;
  message: string;
}

export interface ParseResult {
  expr: Expr | null;
  errors: ParseError[];
}

export function parse(input: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(input);
  if (lexErrors.length > 0) {
    return {
      expr: null,
      errors: lexErrors.map((e) => ({
        line: e.line,
        col: e.col,
        message: e.message,
      })),
    };
  }
  const parser = new Parser(tokens);
  const expr = parser.parseExpr();
  if (!parser.isAtEnd()) {
    parser.error(`Unexpected token '${parser.current().text}'`);
  }
  return { expr: parser.errors.length > 0 ? null : expr, errors: parser.errors };
}

// ---------------------------------------------------------------------------
// Known aggregates
// ---------------------------------------------------------------------------

/** Names recognised by the parser as aggregate functions (→ AggregateCall). */
export const KNOWN_AGGREGATES: ReadonlySet<string> = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "FIRST",
  "LAST",
  "COUNT_DISTINCT",
  "COLLECT_LIST",
  "COLLECT_SET",
  "ANY_VALUE",
  "STDDEV",
  "VARIANCE",
  // Conditional aggregates
  "COUNT_IF",
  "SUM_IF",
  "AVG_IF",
  // Spark percentile/approx
  "PERCENTILE",
  "PERCENTILE_APPROX",
  "APPROX_COUNT_DISTINCT",
]);

// ---------------------------------------------------------------------------
// Type keyword mapping
// ---------------------------------------------------------------------------

const TYPE_TOKEN_MAP: Partial<Record<TokenKind, ScalarTypeKind>> = {
  STRING_TYPE: "string",
  INT32_TYPE: "int32",
  INT64_TYPE: "int64",
  FLOAT_TYPE: "float",
  DOUBLE_TYPE: "double",
  BOOLEAN_TYPE: "boolean",
  TIMESTAMP_TYPE: "timestamp",
  DATE_TYPE: "date",
  JSON_TYPE: "json",
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MAX_DEPTH = 128;
const MAX_LIST_LENGTH = 10_000;
const MAX_WHEN_CLAUSES = 1_000;

class Parser {
  pos = 0;
  errors: ParseError[] = [];
  private depth = 0;

  constructor(private tokens: Token[]) {}

  // -- helpers ---------------------------------------------------------------

  current(): Token {
    return this.tokens[this.pos];
  }

  peek(): TokenKind {
    return this.current().kind;
  }

  isAtEnd(): boolean {
    return this.peek() === "EOF";
  }

  advance(): Token {
    const tok = this.current();
    if (!this.isAtEnd()) this.pos++;
    return tok;
  }

  expect(kind: TokenKind): Token {
    if (this.peek() === kind) return this.advance();
    const tok = this.current();
    this.error(`Expected ${kind} but got '${tok.text}'`);
    return tok;
  }

  match(...kinds: TokenKind[]): Token | null {
    if (kinds.includes(this.peek())) return this.advance();
    return null;
  }

  check(...kinds: TokenKind[]): boolean {
    return kinds.includes(this.peek());
  }

  error(message: string) {
    const tok = this.current();
    this.errors.push({ line: tok.line, col: tok.col, message });
  }

  loc(start: Token, end?: Token): Loc {
    const e = end ?? this.tokens[this.pos - 1] ?? start;
    return {
      startLine: start.line,
      startCol: start.col,
      stopLine: e.line,
      stopCol: e.col + e.text.length,
    };
  }

  // -- grammar ---------------------------------------------------------------

  parseExpr(): Expr {
    if (this.depth >= MAX_DEPTH) {
      this.error("Maximum expression nesting depth exceeded");
      const tok = this.current();
      return { kind: "NullLiteral", loc: this.loc(tok) };
    }
    this.depth++;
    try {
      return this.orExpr();
    } finally {
      this.depth--;
    }
  }

  orExpr(): Expr {
    let left = this.andExpr();
    while (this.match("OR")) {
      const right = this.andExpr();
      const loc: Loc = {
        startLine: left.loc?.startLine ?? 1,
        startCol: left.loc?.startCol ?? 1,
        stopLine: right.loc?.stopLine ?? 1,
        stopCol: right.loc?.stopCol ?? 1,
      };
      left = { kind: "BinaryExpr", op: "OR", left, right, loc };
    }
    return left;
  }

  andExpr(): Expr {
    let left = this.notExpr();
    while (this.match("AND")) {
      const right = this.notExpr();
      const loc: Loc = {
        startLine: left.loc?.startLine ?? 1,
        startCol: left.loc?.startCol ?? 1,
        stopLine: right.loc?.stopLine ?? 1,
        stopCol: right.loc?.stopCol ?? 1,
      };
      left = { kind: "BinaryExpr", op: "AND", left, right, loc };
    }
    return left;
  }

  notExpr(): Expr {
    const start = this.current();
    if (this.match("NOT")) {
      const operand = this.notExpr();
      return { kind: "UnaryExpr", op: "NOT", operand, loc: this.loc(start) };
    }
    return this.comparison();
  }

  comparison(): Expr {
    const startTok = this.current();
    const left = this.addition();

    // IS [NOT] NULL
    if (this.match("IS")) {
      const negated = !!this.match("NOT");
      this.expect("NULL");
      return { kind: "IsNullExpr", expr: left, negated, loc: this.loc(startTok) };
    }

    // [NOT] BETWEEN ... AND ...
    if (this.check("BETWEEN") || (this.check("NOT") && this.lookAhead(1) === "BETWEEN")) {
      const negated = !!this.match("NOT");
      this.expect("BETWEEN");
      const low = this.addition();
      this.expect("AND");
      const high = this.addition();
      return { kind: "BetweenExpr", expr: left, low, high, negated, loc: this.loc(startTok) };
    }

    // [NOT] IN (...)
    if (this.check("IN") || (this.check("NOT") && this.lookAhead(1) === "IN")) {
      const negated = !!this.match("NOT");
      this.expect("IN");
      this.expect("LPAREN");
      const values = this.exprList();
      this.expect("RPAREN");
      return { kind: "InExpr", expr: left, values, negated, loc: this.loc(startTok) };
    }

    // [NOT] LIKE
    if (this.check("LIKE") || (this.check("NOT") && this.lookAhead(1) === "LIKE")) {
      const negated = !!this.match("NOT");
      this.expect("LIKE");
      const pattern = this.addition();
      return { kind: "LikeExpr", expr: left, pattern, negated, loc: this.loc(startTok) };
    }

    // Comparison operators
    const compOp = this.matchCompOp();
    if (compOp) {
      const right = this.addition();
      const loc: Loc = {
        startLine: left.loc?.startLine ?? 1,
        startCol: left.loc?.startCol ?? 1,
        stopLine: right.loc?.stopLine ?? 1,
        stopCol: right.loc?.stopCol ?? 1,
      };
      return { kind: "BinaryExpr", op: compOp, left, right, loc };
    }

    return left;
  }

  matchCompOp(): BinaryOp | null {
    const tok = this.current();
    switch (tok.kind) {
      case "EQ":
        this.advance();
        return "=";
      case "NEQ":
        this.advance();
        return "!=";
      case "LTGT":
        this.advance();
        return "<>";
      case "LT":
        this.advance();
        return "<";
      case "LTE":
        this.advance();
        return "<=";
      case "GT":
        this.advance();
        return ">";
      case "GTE":
        this.advance();
        return ">=";
      default:
        return null;
    }
  }

  addition(): Expr {
    let left = this.multiply();
    while (this.check("PLUS", "MINUS", "PIPE_PIPE")) {
      const tok = this.advance();
      const op: BinaryOp =
        tok.kind === "PLUS" ? "+" : tok.kind === "MINUS" ? "-" : "||";
      const right = this.multiply();
      const loc: Loc = {
        startLine: left.loc?.startLine ?? 1,
        startCol: left.loc?.startCol ?? 1,
        stopLine: right.loc?.stopLine ?? 1,
        stopCol: right.loc?.stopCol ?? 1,
      };
      left = { kind: "BinaryExpr", op, left, right, loc };
    }
    return left;
  }

  multiply(): Expr {
    let left = this.unary();
    while (this.check("STAR", "SLASH", "PERCENT")) {
      const tok = this.advance();
      const op: BinaryOp =
        tok.kind === "STAR" ? "*" : tok.kind === "SLASH" ? "/" : "%";
      const right = this.unary();
      const loc: Loc = {
        startLine: left.loc?.startLine ?? 1,
        startCol: left.loc?.startCol ?? 1,
        stopLine: right.loc?.stopLine ?? 1,
        stopCol: right.loc?.stopCol ?? 1,
      };
      left = { kind: "BinaryExpr", op, left, right, loc };
    }
    return left;
  }

  unary(): Expr {
    const start = this.current();
    if (this.match("MINUS")) {
      if (this.depth >= MAX_DEPTH) {
        this.error("Maximum expression nesting depth exceeded");
        return { kind: "NullLiteral", loc: this.loc(start) };
      }
      this.depth++;
      try {
        const operand = this.unary();
        return { kind: "UnaryExpr", op: "-", operand, loc: this.loc(start) };
      } finally {
        this.depth--;
      }
    }
    return this.primary();
  }

  primary(): Expr {
    const tok = this.current();

    // Literals
    if (this.match("INTEGER")) {
      return { kind: "IntLiteral", value: tok.text, loc: this.loc(tok) };
    }
    if (this.match("DECIMAL")) {
      return { kind: "FloatLiteral", value: tok.text, loc: this.loc(tok) };
    }
    if (this.match("STRING")) {
      return { kind: "StringLiteral", value: tok.text, loc: this.loc(tok) };
    }
    if (this.match("TRUE")) {
      return { kind: "BoolLiteral", value: true, loc: this.loc(tok) };
    }
    if (this.match("FALSE")) {
      return { kind: "BoolLiteral", value: false, loc: this.loc(tok) };
    }
    if (this.match("NULL")) {
      return { kind: "NullLiteral", loc: this.loc(tok) };
    }

    // CASE expression
    if (this.check("CASE")) {
      return this.caseExpr();
    }

    // CAST expression
    if (this.check("CAST")) {
      return this.castExpr();
    }

    // Parenthesized expression
    if (this.match("LPAREN")) {
      const expr = this.parseExpr();
      this.expect("RPAREN");
      return expr;
    }

    // Bare * (for count(*) — should not appear at top level normally)
    if (this.match("STAR")) {
      return { kind: "Star", loc: this.loc(tok) };
    }

    // FIRST and LAST are lexer keywords (for NULLS FIRST/LAST in ORDER BY),
    // but also valid aggregate function names. When followed by '(', treat as function call.
    // This is safe because NULLS FIRST/LAST never appears before '(' in the grammar.
    if ((this.check("FIRST") || this.check("LAST")) && this.lookAhead(1) === "LPAREN") {
      const kwTok = this.advance();
      return this.functionCallExpr(kwTok.text.toUpperCase(), kwTok);
    }

    // Identifier: could be column ref, table.column, or function call
    if (this.check("IDENT")) {
      return this.identExpr();
    }

    // Error recovery
    this.error(`Unexpected token '${tok.text}'`);
    this.advance();
    return { kind: "NullLiteral", loc: this.loc(tok) };
  }

  identExpr(): Expr {
    const ident = this.advance(); // IDENT
    const name = ident.text;

    // function call: IDENT '('
    if (this.check("LPAREN")) {
      return this.functionCallExpr(name, ident);
    }

    // table.column or table.*
    if (this.match("DOT")) {
      if (this.match("STAR")) {
        return { kind: "Star", table: name, loc: this.loc(ident) };
      }
      const col = this.expect("IDENT");
      // table.column could also be a function call? Unlikely but keep it simple.
      return { kind: "ColumnRef", table: name, column: col.text, loc: this.loc(ident) };
    }

    // plain column ref
    return { kind: "ColumnRef", column: name, loc: this.loc(ident) };
  }

  functionCallExpr(name: string, startToken: Token): Expr {
    this.expect("LPAREN");
    const upperName = name.toUpperCase();
    const isAggregate = KNOWN_AGGREGATES.has(upperName);

    // COUNT(*)
    if (upperName === "COUNT" && this.check("STAR")) {
      this.advance(); // *
      this.expect("RPAREN");
      const filter = this.tryParseFilter();
      const base: AggregateCall = {
        kind: "AggregateCall",
        name: upperName,
        args: [{ kind: "Star" }],
        filter: filter ?? undefined,
        loc: this.loc(startToken),
      };
      return this.tryParseWindow(base, startToken);
    }

    // DISTINCT
    const distinct = !!this.match("DISTINCT");

    // Empty args: func()
    let args: Expr[] = [];
    if (!this.check("RPAREN")) {
      args = this.exprList();
    }
    this.expect("RPAREN");

    if (isAggregate) {
      const filter = this.tryParseFilter();
      const base: AggregateCall = {
        kind: "AggregateCall",
        name: upperName,
        args,
        distinct: distinct || undefined,
        filter: filter ?? undefined,
        loc: this.loc(startToken),
      };
      return this.tryParseWindow(base, startToken);
    }

    const base: FunctionCall = {
      kind: "FunctionCall",
      name: upperName,
      args,
      loc: this.loc(startToken),
    };
    return this.tryParseWindow(base, startToken);
  }

  tryParseFilter(): Expr | null {
    if (!this.check("FILTER")) return null;
    this.advance(); // FILTER
    this.expect("LPAREN");
    this.expect("WHERE");
    const expr = this.parseExpr();
    this.expect("RPAREN");
    return expr;
  }

  tryParseWindow(
    func: AggregateCall | FunctionCall,
    startToken: Token
  ): Expr {
    if (!this.check("OVER")) return func;
    this.advance(); // OVER
    this.expect("LPAREN");

    // PARTITION BY
    let partitionBy: Expr[] = [];
    if (this.check("PARTITION")) {
      this.advance(); // PARTITION
      this.expect("BY");
      partitionBy = this.exprList();
    }

    // ORDER BY
    let orderBy: OrderByItem[] = [];
    if (this.check("ORDER")) {
      this.advance(); // ORDER
      this.expect("BY");
      orderBy = this.orderByList();
    }

    // Frame
    let frame: WindowFrame | undefined;
    if (this.check("ROWS", "RANGE")) {
      frame = this.windowFrame();
    }

    this.expect("RPAREN");

    return {
      kind: "WindowExpr",
      func,
      partitionBy,
      orderBy,
      frame,
      loc: this.loc(startToken),
    };
  }

  orderByList(): OrderByItem[] {
    const items: OrderByItem[] = [];
    items.push(this.orderByItem());
    while (this.match("COMMA")) {
      items.push(this.orderByItem());
    }
    return items;
  }

  orderByItem(): OrderByItem {
    const expr = this.parseExpr();
    let direction: "ASC" | "DESC" = "ASC";
    if (this.match("ASC")) {
      direction = "ASC";
    } else if (this.match("DESC")) {
      direction = "DESC";
    }
    let nulls: "FIRST" | "LAST" | undefined;
    if (this.match("NULLS")) {
      if (this.match("FIRST")) {
        nulls = "FIRST";
      } else {
        this.expect("LAST");
        nulls = "LAST";
      }
    }
    return { expr, direction, nulls };
  }

  windowFrame(): WindowFrame {
    const type = this.advance().kind === "ROWS" ? "ROWS" as const : "RANGE" as const;
    const start = this.frameBound();
    let end: FrameBound | undefined;
    if (this.match("AND")) {
      end = this.frameBound();
    }
    return { type, start, end };
  }

  frameBound(): FrameBound {
    if (this.check("UNBOUNDED")) {
      this.advance();
      if (this.match("PRECEDING")) {
        return { kind: "UNBOUNDED_PRECEDING" };
      }
      this.expect("FOLLOWING");
      return { kind: "UNBOUNDED_FOLLOWING" };
    }
    if (this.check("CURRENT")) {
      this.advance();
      this.expect("ROW");
      return { kind: "CURRENT_ROW" };
    }
    // N PRECEDING | N FOLLOWING
    const offset = this.parseExpr();
    if (this.match("PRECEDING")) {
      return { kind: "PRECEDING", offset };
    }
    this.expect("FOLLOWING");
    return { kind: "FOLLOWING", offset };
  }

  caseExpr(): Expr {
    const start = this.advance(); // CASE

    // Simple CASE: CASE expr WHEN ...
    // Searched CASE: CASE WHEN ...
    let operand: Expr | undefined;
    if (!this.check("WHEN")) {
      operand = this.parseExpr();
    }

    const whens: { condition: Expr; result: Expr }[] = [];
    while (this.match("WHEN")) {
      if (whens.length >= MAX_WHEN_CLAUSES) {
        this.error(`Too many WHEN clauses (max ${MAX_WHEN_CLAUSES})`);
        break;
      }
      const condition = this.parseExpr();
      this.expect("THEN");
      const result = this.parseExpr();
      whens.push({ condition, result });
    }

    if (whens.length === 0) {
      this.error("CASE requires at least one WHEN clause");
    }

    let elseResult: Expr | undefined;
    if (this.match("ELSE")) {
      elseResult = this.parseExpr();
    }

    this.expect("END");

    return {
      kind: "CaseExpr",
      operand,
      whens,
      elseResult,
      loc: this.loc(start),
    };
  }

  castExpr(): Expr {
    const start = this.advance(); // CAST
    this.expect("LPAREN");
    const expr = this.parseExpr();
    this.expect("AS");
    const targetType = this.parseTypeName();
    this.expect("RPAREN");
    return {
      kind: "CastExpr",
      expr,
      targetType,
      loc: this.loc(start),
    };
  }

  parseTypeName(): ScalarTypeKind {
    const tok = this.current();
    const mapped = TYPE_TOKEN_MAP[tok.kind];
    if (mapped) {
      this.advance();
      return mapped;
    }
    this.error(`Expected type name but got '${tok.text}'`);
    this.advance();
    return "unknown";
  }

  exprList(): Expr[] {
    const exprs: Expr[] = [];
    exprs.push(this.parseExpr());
    while (this.match("COMMA")) {
      if (exprs.length >= MAX_LIST_LENGTH) {
        this.error(`List too long (max ${MAX_LIST_LENGTH} items)`);
        break;
      }
      exprs.push(this.parseExpr());
    }
    return exprs;
  }

  lookAhead(offset: number): TokenKind {
    const idx = this.pos + offset;
    if (idx < this.tokens.length) return this.tokens[idx].kind;
    return "EOF";
  }
}
