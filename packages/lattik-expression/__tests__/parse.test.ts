import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parse.js";
import type { Expr } from "../src/ast/nodes.js";

function parseOk(input: string): Expr {
  const result = parse(input);
  expect(result.errors).toEqual([]);
  expect(result.expr).not.toBeNull();
  return result.expr!;
}

describe("parse", () => {
  describe("literals", () => {
    it("integer", () => {
      const e = parseOk("42");
      expect(e).toMatchObject({ kind: "IntLiteral", value: "42" });
    });

    it("decimal", () => {
      const e = parseOk("3.14");
      expect(e).toMatchObject({ kind: "FloatLiteral", value: "3.14" });
    });

    it("string", () => {
      const e = parseOk("'hello'");
      expect(e).toMatchObject({ kind: "StringLiteral", value: "hello" });
    });

    it("string with escaped quotes", () => {
      const e = parseOk("'it''s'");
      expect(e).toMatchObject({ kind: "StringLiteral", value: "it's" });
    });

    it("TRUE", () => {
      const e = parseOk("TRUE");
      expect(e).toMatchObject({ kind: "BoolLiteral", value: true });
    });

    it("FALSE", () => {
      const e = parseOk("false");
      expect(e).toMatchObject({ kind: "BoolLiteral", value: false });
    });

    it("NULL", () => {
      const e = parseOk("NULL");
      expect(e).toMatchObject({ kind: "NullLiteral" });
    });
  });

  describe("column references", () => {
    it("simple column", () => {
      const e = parseOk("amount");
      expect(e).toMatchObject({ kind: "ColumnRef", column: "amount" });
    });

    it("table.column", () => {
      const e = parseOk("t.amount");
      expect(e).toMatchObject({
        kind: "ColumnRef",
        table: "t",
        column: "amount",
      });
    });

    it("quoted identifier", () => {
      const e = parseOk('"my column"');
      expect(e).toMatchObject({ kind: "ColumnRef", column: "my column" });
    });
  });

  describe("arithmetic", () => {
    it("a + b", () => {
      const e = parseOk("a + b");
      expect(e).toMatchObject({
        kind: "BinaryExpr",
        op: "+",
        left: { kind: "ColumnRef", column: "a" },
        right: { kind: "ColumnRef", column: "b" },
      });
    });

    it("precedence: a + b * c", () => {
      const e = parseOk("a + b * c");
      expect(e).toMatchObject({
        kind: "BinaryExpr",
        op: "+",
        left: { kind: "ColumnRef", column: "a" },
        right: {
          kind: "BinaryExpr",
          op: "*",
          left: { kind: "ColumnRef", column: "b" },
          right: { kind: "ColumnRef", column: "c" },
        },
      });
    });

    it("parentheses: (a + b) * c", () => {
      const e = parseOk("(a + b) * c");
      expect(e).toMatchObject({
        kind: "BinaryExpr",
        op: "*",
        left: {
          kind: "BinaryExpr",
          op: "+",
          left: { kind: "ColumnRef", column: "a" },
          right: { kind: "ColumnRef", column: "b" },
        },
        right: { kind: "ColumnRef", column: "c" },
      });
    });

    it("unary minus", () => {
      const e = parseOk("-a");
      expect(e).toMatchObject({
        kind: "UnaryExpr",
        op: "-",
        operand: { kind: "ColumnRef", column: "a" },
      });
    });

    it("string concat", () => {
      const e = parseOk("a || b");
      expect(e).toMatchObject({ kind: "BinaryExpr", op: "||" });
    });
  });

  describe("comparison", () => {
    it("a > 0", () => {
      const e = parseOk("a > 0");
      expect(e).toMatchObject({
        kind: "BinaryExpr",
        op: ">",
        left: { kind: "ColumnRef", column: "a" },
        right: { kind: "IntLiteral", value: "0" },
      });
    });

    it("a != b", () => {
      const e = parseOk("a != b");
      expect(e).toMatchObject({ kind: "BinaryExpr", op: "!=" });
    });

    it("a <> b", () => {
      const e = parseOk("a <> b");
      expect(e).toMatchObject({ kind: "BinaryExpr", op: "<>" });
    });
  });

  describe("logical", () => {
    it("a AND b OR c", () => {
      const e = parseOk("a AND b OR c");
      // OR has lower precedence, so: (a AND b) OR c
      expect(e).toMatchObject({
        kind: "BinaryExpr",
        op: "OR",
        left: { kind: "BinaryExpr", op: "AND" },
        right: { kind: "ColumnRef", column: "c" },
      });
    });

    it("NOT a", () => {
      const e = parseOk("NOT a");
      expect(e).toMatchObject({
        kind: "UnaryExpr",
        op: "NOT",
        operand: { kind: "ColumnRef", column: "a" },
      });
    });
  });

  describe("predicates", () => {
    it("IS NULL", () => {
      const e = parseOk("a IS NULL");
      expect(e).toMatchObject({
        kind: "IsNullExpr",
        expr: { kind: "ColumnRef", column: "a" },
        negated: false,
      });
    });

    it("IS NOT NULL", () => {
      const e = parseOk("a IS NOT NULL");
      expect(e).toMatchObject({ kind: "IsNullExpr", negated: true });
    });

    it("BETWEEN", () => {
      const e = parseOk("a BETWEEN 1 AND 10");
      expect(e).toMatchObject({
        kind: "BetweenExpr",
        expr: { kind: "ColumnRef", column: "a" },
        low: { kind: "IntLiteral", value: "1" },
        high: { kind: "IntLiteral", value: "10" },
        negated: false,
      });
    });

    it("NOT BETWEEN", () => {
      const e = parseOk("a NOT BETWEEN 1 AND 10");
      expect(e).toMatchObject({ kind: "BetweenExpr", negated: true });
    });

    it("IN", () => {
      const e = parseOk("a IN (1, 2, 3)");
      expect(e).toMatchObject({
        kind: "InExpr",
        values: [
          { kind: "IntLiteral", value: "1" },
          { kind: "IntLiteral", value: "2" },
          { kind: "IntLiteral", value: "3" },
        ],
        negated: false,
      });
    });

    it("NOT IN", () => {
      const e = parseOk("a NOT IN ('x', 'y')");
      expect(e).toMatchObject({ kind: "InExpr", negated: true });
    });

    it("LIKE", () => {
      const e = parseOk("name LIKE '%foo%'");
      expect(e).toMatchObject({
        kind: "LikeExpr",
        expr: { kind: "ColumnRef", column: "name" },
        pattern: { kind: "StringLiteral", value: "%foo%" },
        negated: false,
      });
    });

    it("NOT LIKE", () => {
      const e = parseOk("name NOT LIKE '%test%'");
      expect(e).toMatchObject({ kind: "LikeExpr", negated: true });
    });
  });

  describe("CASE", () => {
    it("searched CASE", () => {
      const e = parseOk("CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END");
      expect(e).toMatchObject({
        kind: "CaseExpr",
        operand: undefined,
        whens: [
          {
            condition: { kind: "BinaryExpr", op: ">" },
            result: { kind: "StringLiteral", value: "pos" },
          },
        ],
        elseResult: { kind: "StringLiteral", value: "neg" },
      });
    });

    it("simple CASE", () => {
      const e = parseOk("CASE status WHEN 1 THEN 'active' WHEN 2 THEN 'inactive' END");
      expect(e).toMatchObject({
        kind: "CaseExpr",
        operand: { kind: "ColumnRef", column: "status" },
        whens: [
          { condition: { kind: "IntLiteral", value: "1" } },
          { condition: { kind: "IntLiteral", value: "2" } },
        ],
      });
    });
  });

  describe("CAST", () => {
    it("CAST(a AS INT64)", () => {
      const e = parseOk("CAST(a AS INT64)");
      expect(e).toMatchObject({
        kind: "CastExpr",
        expr: { kind: "ColumnRef", column: "a" },
        targetType: "int64",
      });
    });

    it("CAST to all types", () => {
      for (const t of ["STRING", "INT32", "INT64", "FLOAT", "DOUBLE", "BOOLEAN", "TIMESTAMP", "DATE", "JSON"]) {
        const e = parseOk(`CAST(x AS ${t})`);
        expect(e.kind).toBe("CastExpr");
      }
    });
  });

  describe("function calls", () => {
    it("COALESCE(a, 0)", () => {
      const e = parseOk("COALESCE(a, 0)");
      expect(e).toMatchObject({
        kind: "FunctionCall",
        name: "COALESCE",
        args: [
          { kind: "ColumnRef", column: "a" },
          { kind: "IntLiteral", value: "0" },
        ],
      });
    });

    it("LOWER(name)", () => {
      const e = parseOk("LOWER(name)");
      expect(e).toMatchObject({
        kind: "FunctionCall",
        name: "LOWER",
        args: [{ kind: "ColumnRef", column: "name" }],
      });
    });
  });

  describe("aggregates", () => {
    it("SUM(amount)", () => {
      const e = parseOk("SUM(amount)");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "SUM",
        args: [{ kind: "ColumnRef", column: "amount" }],
      });
    });

    it("COUNT(*)", () => {
      const e = parseOk("COUNT(*)");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "COUNT",
        args: [{ kind: "Star" }],
      });
    });

    it("COUNT(DISTINCT user_id)", () => {
      const e = parseOk("COUNT(DISTINCT user_id)");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "COUNT",
        distinct: true,
        args: [{ kind: "ColumnRef", column: "user_id" }],
      });
    });

    it("AVG(price) FILTER (WHERE status = 'active')", () => {
      const e = parseOk("AVG(price) FILTER (WHERE status = 'active')");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "AVG",
        filter: {
          kind: "BinaryExpr",
          op: "=",
          left: { kind: "ColumnRef", column: "status" },
          right: { kind: "StringLiteral", value: "active" },
        },
      });
    });
  });

  describe("window functions", () => {
    it("SUM(amount) OVER (PARTITION BY user_id)", () => {
      const e = parseOk("SUM(amount) OVER (PARTITION BY user_id)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "AggregateCall", name: "SUM" },
        partitionBy: [{ kind: "ColumnRef", column: "user_id" }],
        orderBy: [],
      });
    });

    it("ROW_NUMBER() OVER (ORDER BY id)", () => {
      const e = parseOk("ROW_NUMBER() OVER (ORDER BY id)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "ROW_NUMBER" },
        orderBy: [
          {
            expr: { kind: "ColumnRef", column: "id" },
            direction: "ASC",
          },
        ],
      });
    });

    it("window with frame", () => {
      const e = parseOk(
        "SUM(amount) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING AND CURRENT ROW)"
      );
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "AggregateCall", name: "SUM" },
        frame: {
          type: "ROWS",
          start: { kind: "UNBOUNDED_PRECEDING" },
          end: { kind: "CURRENT_ROW" },
        },
      });
    });

    it("window with ORDER BY DESC NULLS LAST", () => {
      const e = parseOk("SUM(x) OVER (ORDER BY a DESC NULLS LAST)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        orderBy: [{ direction: "DESC", nulls: "LAST" }],
      });
    });
  });

  describe("complex expressions", () => {
    it("nested arithmetic and comparison", () => {
      const e = parseOk("(revenue - cost) / revenue * 100 > 50");
      expect(e.kind).toBe("BinaryExpr");
    });

    it("CASE with aggregation", () => {
      const e = parseOk(
        "SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END)"
      );
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "SUM",
        args: [{ kind: "CaseExpr" }],
      });
    });
  });

  describe("conditional aggregates", () => {
    it("COUNT_IF(condition)", () => {
      const e = parseOk("COUNT_IF(is_active)");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "COUNT_IF",
        args: [{ kind: "ColumnRef", column: "is_active" }],
      });
    });

    it("SUM_IF(value, condition)", () => {
      const e = parseOk("SUM_IF(amount, status = 'active')");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "SUM_IF",
        args: [
          { kind: "ColumnRef", column: "amount" },
          { kind: "BinaryExpr", op: "=" },
        ],
      });
    });

    it("AVG_IF(value, condition)", () => {
      const e = parseOk("AVG_IF(price, quantity > 0)");
      expect(e).toMatchObject({
        kind: "AggregateCall",
        name: "AVG_IF",
      });
    });
  });

  describe("spark aggregates", () => {
    it("PERCENTILE(col, 0.5)", () => {
      const e = parseOk("PERCENTILE(amount, 0.5)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "PERCENTILE" });
    });

    it("APPROX_COUNT_DISTINCT(col)", () => {
      const e = parseOk("APPROX_COUNT_DISTINCT(user_id)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "APPROX_COUNT_DISTINCT" });
    });

    it("MIN(col)", () => {
      const e = parseOk("MIN(amount)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "MIN" });
    });

    it("MAX(col)", () => {
      const e = parseOk("MAX(amount)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "MAX" });
    });

    it("FIRST(col)", () => {
      const e = parseOk("FIRST(name)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "FIRST" });
    });

    it("LAST(col)", () => {
      const e = parseOk("LAST(name)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "LAST" });
    });

    it("COLLECT_LIST(col)", () => {
      const e = parseOk("COLLECT_LIST(tag)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "COLLECT_LIST" });
    });

    it("STDDEV(col)", () => {
      const e = parseOk("STDDEV(amount)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "STDDEV" });
    });

    it("VARIANCE(col)", () => {
      const e = parseOk("VARIANCE(amount)");
      expect(e).toMatchObject({ kind: "AggregateCall", name: "VARIANCE" });
    });
  });

  describe("window function variants", () => {
    it("RANK() OVER (ORDER BY score DESC)", () => {
      const e = parseOk("RANK() OVER (ORDER BY score DESC)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "RANK" },
        orderBy: [{ direction: "DESC" }],
      });
    });

    it("DENSE_RANK() OVER (PARTITION BY category ORDER BY value)", () => {
      const e = parseOk("DENSE_RANK() OVER (PARTITION BY category ORDER BY value)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "DENSE_RANK" },
      });
    });

    it("NTILE(4) OVER (ORDER BY revenue)", () => {
      const e = parseOk("NTILE(4) OVER (ORDER BY revenue)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "NTILE", args: [{ kind: "IntLiteral", value: "4" }] },
      });
    });

    it("LAG(amount, 1) OVER (ORDER BY date)", () => {
      const e = parseOk("LAG(amount, 1) OVER (ORDER BY date)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "LAG" },
      });
    });

    it("LEAD(amount, 1, 0) OVER (ORDER BY date)", () => {
      const e = parseOk("LEAD(amount, 1, 0) OVER (ORDER BY date)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "LEAD" },
      });
    });

    it("window with N PRECEDING offset frame", () => {
      const e = parseOk("SUM(amount) OVER (ORDER BY date ROWS 3 PRECEDING AND CURRENT ROW)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        frame: {
          type: "ROWS",
          start: { kind: "PRECEDING", offset: { kind: "IntLiteral", value: "3" } },
          end: { kind: "CURRENT_ROW" },
        },
      });
    });

    it("window with multiple ORDER BY columns", () => {
      const e = parseOk("SUM(x) OVER (ORDER BY a ASC, b DESC NULLS FIRST)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        orderBy: [
          { direction: "ASC" },
          { direction: "DESC", nulls: "FIRST" },
        ],
      });
    });
  });

  describe("spark scalar functions", () => {
    it("YEAR(date_col)", () => {
      const e = parseOk("YEAR(created_at)");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "YEAR" });
    });

    it("DATE_ADD(date_col, 7)", () => {
      const e = parseOk("DATE_ADD(created_at, 7)");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "DATE_ADD" });
    });

    it("REPLACE(str, old, new)", () => {
      const e = parseOk("REPLACE(name, 'a', 'b')");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "REPLACE" });
    });

    it("GREATEST(a, b, c)", () => {
      const e = parseOk("GREATEST(a, b, c)");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "GREATEST", args: [{}, {}, {}] });
    });

    it("MD5(value)", () => {
      const e = parseOk("MD5(name)");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "MD5" });
    });

    it("NVL(nullable_col, default)", () => {
      const e = parseOk("NVL(price, 0)");
      expect(e).toMatchObject({ kind: "FunctionCall", name: "NVL" });
    });

    it("ROW_NUMBER() parsed as FunctionCall", () => {
      const e = parseOk("ROW_NUMBER() OVER (ORDER BY id)");
      expect(e).toMatchObject({
        kind: "WindowExpr",
        func: { kind: "FunctionCall", name: "ROW_NUMBER" },
      });
    });
  });

  describe("loc on nodes", () => {
    it("BinaryExpr has loc", () => {
      const e = parseOk("a + b");
      expect(e.loc).toBeDefined();
      expect(e.loc!.startLine).toBe(1);
    });

    it("IsNullExpr has loc", () => {
      const e = parseOk("a IS NULL");
      expect(e.loc).toBeDefined();
    });

    it("BetweenExpr has loc", () => {
      const e = parseOk("a BETWEEN 1 AND 10");
      expect(e.loc).toBeDefined();
    });

    it("InExpr has loc", () => {
      const e = parseOk("a IN (1, 2)");
      expect(e.loc).toBeDefined();
    });

    it("LikeExpr has loc", () => {
      const e = parseOk("name LIKE '%foo%'");
      expect(e.loc).toBeDefined();
    });
  });

  describe("errors", () => {
    it("unclosed parenthesis", () => {
      const result = parse("(a + b");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("unexpected token", () => {
      const result = parse("a +");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("unterminated string literal", () => {
      const result = parse("'unterminated");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Unterminated string");
    });

    it("unterminated quoted identifier", () => {
      const result = parse('"unterminated');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Unterminated quoted");
    });

    it("deeply nested parentheses hits depth limit", () => {
      const deep = "(".repeat(200) + "1" + ")".repeat(200);
      const result = parse(deep);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("depth");
    });

    it("deeply nested unary minus hits depth limit", () => {
      // Use "- (" to avoid "--" being parsed as a comment
      const deep = "- (".repeat(200) + "1" + ")".repeat(200);
      const result = parse(deep);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("depth");
    });

    it("input exceeding max length is rejected", () => {
      const huge = "a + " .repeat(300_000); // > 1MB
      const result = parse(huge);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Input too large");
    });

    it("numeric literal exceeding max length is rejected", () => {
      const bigNum = "9".repeat(200);
      const result = parse(bigNum);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Numeric literal too long");
    });

    it("identifier with double quotes is properly escaped in emitter", () => {
      // This tests that parsing a quoted identifier with special chars works
      const result = parse('"my col"');
      expect(result.errors).toEqual([]);
      expect(result.expr).toMatchObject({ kind: "ColumnRef", column: "my col" });
    });
  });
});
