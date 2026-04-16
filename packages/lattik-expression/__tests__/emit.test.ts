import { describe, it, expect } from "vitest";
import { emitSql } from "../src/emitter/emit-sql.js";
import type { Expr } from "../src/ast/nodes.js";

describe("emitSql", () => {
  it("integer literal", () => {
    const e: Expr = { kind: "IntLiteral", value: "42" };
    expect(emitSql(e)).toBe("42");
  });

  it("float literal", () => {
    const e: Expr = { kind: "FloatLiteral", value: "3.14" };
    expect(emitSql(e)).toBe("3.14");
  });

  it("string literal", () => {
    const e: Expr = { kind: "StringLiteral", value: "hello" };
    expect(emitSql(e)).toBe("'hello'");
  });

  it("string literal with quote", () => {
    const e: Expr = { kind: "StringLiteral", value: "it's" };
    expect(emitSql(e)).toBe("'it''s'");
  });

  it("boolean TRUE", () => {
    const e: Expr = { kind: "BoolLiteral", value: true };
    expect(emitSql(e)).toBe("TRUE");
  });

  it("NULL", () => {
    const e: Expr = { kind: "NullLiteral" };
    expect(emitSql(e)).toBe("NULL");
  });

  it("column ref", () => {
    const e: Expr = { kind: "ColumnRef", column: "amount" };
    expect(emitSql(e)).toBe("amount");
  });

  it("table.column ref", () => {
    const e: Expr = { kind: "ColumnRef", table: "t", column: "amount" };
    expect(emitSql(e)).toBe("t.amount");
  });

  it("binary expr", () => {
    const e: Expr = {
      kind: "BinaryExpr",
      op: "+",
      left: { kind: "ColumnRef", column: "a" },
      right: { kind: "IntLiteral", value: "1" },
    };
    expect(emitSql(e)).toBe("a + 1");
  });

  it("parenthesizes lower-precedence children", () => {
    const e: Expr = {
      kind: "BinaryExpr",
      op: "*",
      left: {
        kind: "BinaryExpr",
        op: "+",
        left: { kind: "ColumnRef", column: "a" },
        right: { kind: "ColumnRef", column: "b" },
      },
      right: { kind: "ColumnRef", column: "c" },
    };
    expect(emitSql(e)).toBe("(a + b) * c");
  });

  it("does not parenthesize same-precedence left-associative", () => {
    const e: Expr = {
      kind: "BinaryExpr",
      op: "+",
      left: {
        kind: "BinaryExpr",
        op: "+",
        left: { kind: "ColumnRef", column: "a" },
        right: { kind: "ColumnRef", column: "b" },
      },
      right: { kind: "ColumnRef", column: "c" },
    };
    expect(emitSql(e)).toBe("a + b + c");
  });

  it("unary minus", () => {
    const e: Expr = {
      kind: "UnaryExpr",
      op: "-",
      operand: { kind: "ColumnRef", column: "a" },
    };
    expect(emitSql(e)).toBe("-a");
  });

  it("NOT", () => {
    const e: Expr = {
      kind: "UnaryExpr",
      op: "NOT",
      operand: { kind: "BoolLiteral", value: true },
    };
    expect(emitSql(e)).toBe("NOT TRUE");
  });

  it("IS NULL", () => {
    const e: Expr = {
      kind: "IsNullExpr",
      expr: { kind: "ColumnRef", column: "a" },
      negated: false,
    };
    expect(emitSql(e)).toBe("a IS NULL");
  });

  it("IS NOT NULL", () => {
    const e: Expr = {
      kind: "IsNullExpr",
      expr: { kind: "ColumnRef", column: "a" },
      negated: true,
    };
    expect(emitSql(e)).toBe("a IS NOT NULL");
  });

  it("BETWEEN", () => {
    const e: Expr = {
      kind: "BetweenExpr",
      expr: { kind: "ColumnRef", column: "a" },
      low: { kind: "IntLiteral", value: "1" },
      high: { kind: "IntLiteral", value: "10" },
      negated: false,
    };
    expect(emitSql(e)).toBe("a BETWEEN 1 AND 10");
  });

  it("IN", () => {
    const e: Expr = {
      kind: "InExpr",
      expr: { kind: "ColumnRef", column: "a" },
      values: [
        { kind: "IntLiteral", value: "1" },
        { kind: "IntLiteral", value: "2" },
      ],
      negated: false,
    };
    expect(emitSql(e)).toBe("a IN (1, 2)");
  });

  it("LIKE", () => {
    const e: Expr = {
      kind: "LikeExpr",
      expr: { kind: "ColumnRef", column: "name" },
      pattern: { kind: "StringLiteral", value: "%foo%" },
      negated: false,
    };
    expect(emitSql(e)).toBe("name LIKE '%foo%'");
  });

  it("CASE expression", () => {
    const e: Expr = {
      kind: "CaseExpr",
      whens: [
        {
          condition: {
            kind: "BinaryExpr",
            op: ">",
            left: { kind: "ColumnRef", column: "a" },
            right: { kind: "IntLiteral", value: "0" },
          },
          result: { kind: "StringLiteral", value: "pos" },
        },
      ],
      elseResult: { kind: "StringLiteral", value: "neg" },
    };
    expect(emitSql(e)).toBe("CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END");
  });

  it("CAST", () => {
    const e: Expr = {
      kind: "CastExpr",
      expr: { kind: "ColumnRef", column: "a" },
      targetType: "int64",
    };
    expect(emitSql(e)).toBe("CAST(a AS INT64)");
  });

  it("function call", () => {
    const e: Expr = {
      kind: "FunctionCall",
      name: "COALESCE",
      args: [
        { kind: "ColumnRef", column: "a" },
        { kind: "IntLiteral", value: "0" },
      ],
    };
    expect(emitSql(e)).toBe("COALESCE(a, 0)");
  });

  it("aggregate with DISTINCT", () => {
    const e: Expr = {
      kind: "AggregateCall",
      name: "COUNT",
      args: [{ kind: "ColumnRef", column: "user_id" }],
      distinct: true,
    };
    expect(emitSql(e)).toBe("COUNT(DISTINCT user_id)");
  });

  it("aggregate with FILTER", () => {
    const e: Expr = {
      kind: "AggregateCall",
      name: "SUM",
      args: [{ kind: "ColumnRef", column: "amount" }],
      filter: {
        kind: "BinaryExpr",
        op: "=",
        left: { kind: "ColumnRef", column: "status" },
        right: { kind: "StringLiteral", value: "active" },
      },
    };
    expect(emitSql(e)).toBe("SUM(amount) FILTER (WHERE status = 'active')");
  });

  it("window function", () => {
    const e: Expr = {
      kind: "WindowExpr",
      func: {
        kind: "AggregateCall",
        name: "SUM",
        args: [{ kind: "ColumnRef", column: "amount" }],
      },
      partitionBy: [{ kind: "ColumnRef", column: "user_id" }],
      orderBy: [
        {
          expr: { kind: "ColumnRef", column: "date" },
          direction: "ASC" as const,
        },
      ],
    };
    expect(emitSql(e)).toBe(
      "SUM(amount) OVER (PARTITION BY user_id ORDER BY date)"
    );
  });

  it("window function with frame", () => {
    const e: Expr = {
      kind: "WindowExpr",
      func: {
        kind: "AggregateCall",
        name: "SUM",
        args: [{ kind: "ColumnRef", column: "amount" }],
      },
      partitionBy: [],
      orderBy: [
        {
          expr: { kind: "ColumnRef", column: "date" },
          direction: "ASC" as const,
        },
      ],
      frame: {
        type: "ROWS",
        start: { kind: "UNBOUNDED_PRECEDING" },
        end: { kind: "CURRENT_ROW" },
      },
    };
    expect(emitSql(e)).toBe(
      "SUM(amount) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING AND CURRENT ROW)"
    );
  });

  it("conditional aggregate COUNT_IF", () => {
    const e: Expr = {
      kind: "AggregateCall",
      name: "COUNT_IF",
      args: [{ kind: "ColumnRef", column: "is_active" }],
    };
    expect(emitSql(e)).toBe("COUNT_IF(is_active)");
  });

  it("conditional aggregate SUM_IF", () => {
    const e: Expr = {
      kind: "AggregateCall",
      name: "SUM_IF",
      args: [
        { kind: "ColumnRef", column: "amount" },
        { kind: "ColumnRef", column: "active" },
      ],
    };
    expect(emitSql(e)).toBe("SUM_IF(amount, active)");
  });

  it("window with N PRECEDING frame", () => {
    const e: Expr = {
      kind: "WindowExpr",
      func: {
        kind: "AggregateCall",
        name: "SUM",
        args: [{ kind: "ColumnRef", column: "x" }],
      },
      partitionBy: [],
      orderBy: [{ expr: { kind: "ColumnRef", column: "d" }, direction: "ASC" as const }],
      frame: {
        type: "ROWS",
        start: { kind: "PRECEDING", offset: { kind: "IntLiteral", value: "3" } },
        end: { kind: "CURRENT_ROW" },
      },
    };
    expect(emitSql(e)).toBe("SUM(x) OVER (ORDER BY d ROWS 3 PRECEDING AND CURRENT ROW)");
  });

  it("window with ORDER BY DESC NULLS FIRST", () => {
    const e: Expr = {
      kind: "WindowExpr",
      func: { kind: "FunctionCall", name: "ROW_NUMBER", args: [] },
      partitionBy: [],
      orderBy: [
        { expr: { kind: "ColumnRef", column: "a" }, direction: "DESC" as const, nulls: "FIRST" as const },
      ],
    };
    expect(emitSql(e)).toBe("ROW_NUMBER() OVER (ORDER BY a DESC NULLS FIRST)");
  });

  it("quotes SQL reserved keyword identifiers", () => {
    const e: Expr = {
      kind: "ColumnRef",
      column: "select",
    };
    expect(emitSql(e)).toBe('"select"');
  });

  it("quotes table.column where column is keyword", () => {
    const e: Expr = {
      kind: "ColumnRef",
      table: "t",
      column: "order",
    };
    expect(emitSql(e)).toBe('t."order"');
  });

  it("escapes double quotes inside identifiers", () => {
    const e: Expr = {
      kind: "ColumnRef",
      column: 'my"col',
    };
    expect(emitSql(e)).toBe('"my""col"');
  });

  it("escapes identifier with space and quotes", () => {
    const e: Expr = {
      kind: "ColumnRef",
      column: 'a "b" c',
    };
    expect(emitSql(e)).toBe('"a ""b"" c"');
  });
});
