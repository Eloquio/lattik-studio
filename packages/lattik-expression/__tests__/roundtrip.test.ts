import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parse.js";
import { emitSql } from "../src/emitter/emit-sql.js";

/**
 * Round-trip test: parse → emit → parse → emit.
 * The two emitted strings should be identical (canonical form).
 */
function roundtrip(input: string) {
  const r1 = parse(input);
  expect(r1.errors).toEqual([]);
  const sql1 = emitSql(r1.expr!);

  const r2 = parse(sql1);
  expect(r2.errors).toEqual([]);
  const sql2 = emitSql(r2.expr!);

  expect(sql2).toBe(sql1);
  return sql1;
}

describe("roundtrip", () => {
  const cases = [
    // literals
    ["42", "42"],
    ["3.14", "3.14"],
    ["'hello'", "'hello'"],
    ["TRUE", "TRUE"],
    ["NULL", "NULL"],

    // column refs
    ["amount", "amount"],
    ["t.amount", "t.amount"],

    // arithmetic
    ["a + b", "a + b"],
    ["a + b * c", "a + b * c"],
    ["(a + b) * c", "(a + b) * c"],
    ["-a", "-a"],

    // comparison
    ["a > 0", "a > 0"],
    ["a != b", "a != b"],

    // logical
    ["a AND b", "a AND b"],
    ["NOT a", "NOT a"],

    // predicates
    ["a IS NULL", "a IS NULL"],
    ["a IS NOT NULL", "a IS NOT NULL"],
    ["a BETWEEN 1 AND 10", "a BETWEEN 1 AND 10"],
    ["a IN (1, 2, 3)", "a IN (1, 2, 3)"],
    ["name LIKE '%foo%'", "name LIKE '%foo%'"],

    // CASE
    [
      "CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END",
      "CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END",
    ],

    // CAST
    ["CAST(a AS INT64)", "CAST(a AS INT64)"],

    // functions
    ["COALESCE(a, 0)", "COALESCE(a, 0)"],

    // aggregates
    ["SUM(amount)", "SUM(amount)"],
    ["COUNT(*)", "COUNT(*)"],
    ["COUNT(DISTINCT user_id)", "COUNT(DISTINCT user_id)"],

    // window
    [
      "SUM(amount) OVER (PARTITION BY user_id ORDER BY date)",
      "SUM(amount) OVER (PARTITION BY user_id ORDER BY date)",
    ],

    // conditional aggregates
    ["COUNT_IF(active)", "COUNT_IF(active)"],
    ["SUM_IF(amount, active)", "SUM_IF(amount, active)"],
    ["AVG_IF(price, quantity > 0)", "AVG_IF(price, quantity > 0)"],

    // spark aggregates
    ["MIN(amount)", "MIN(amount)"],
    ["MAX(amount)", "MAX(amount)"],
    ["FIRST(name)", "FIRST(name)"],
    ["LAST(name)", "LAST(name)"],
    ["COLLECT_LIST(tag)", "COLLECT_LIST(tag)"],
    ["STDDEV(amount)", "STDDEV(amount)"],
    ["APPROX_COUNT_DISTINCT(user_id)", "APPROX_COUNT_DISTINCT(user_id)"],
    ["PERCENTILE(amount, 0.5)", "PERCENTILE(amount, 0.5)"],

    // window function variants
    ["RANK() OVER (ORDER BY score DESC)", "RANK() OVER (ORDER BY score DESC)"],
    ["DENSE_RANK() OVER (ORDER BY value)", "DENSE_RANK() OVER (ORDER BY value)"],
    ["NTILE(4) OVER (ORDER BY revenue)", "NTILE(4) OVER (ORDER BY revenue)"],
    ["LAG(amount, 1) OVER (ORDER BY date)", "LAG(amount, 1) OVER (ORDER BY date)"],
    ["LEAD(amount, 1, 0) OVER (ORDER BY date)", "LEAD(amount, 1, 0) OVER (ORDER BY date)"],
    [
      "ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date)",
      "ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date)",
    ],
    [
      "SUM(x) OVER (ORDER BY date ROWS 3 PRECEDING AND CURRENT ROW)",
      "SUM(x) OVER (ORDER BY date ROWS 3 PRECEDING AND CURRENT ROW)",
    ],
    [
      "SUM(x) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)",
      "SUM(x) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)",
    ],

    // aggregate with FILTER
    [
      "SUM(amount) FILTER (WHERE active)",
      "SUM(amount) FILTER (WHERE active)",
    ],

    // spark scalar functions
    ["YEAR(created_at)", "YEAR(created_at)"],
    ["DATE_ADD(d, 7)", "DATE_ADD(d, 7)"],
    ["REPLACE(name, 'a', 'b')", "REPLACE(name, 'a', 'b')"],
    ["NVL(price, 0)", "NVL(price, 0)"],
    ["GREATEST(a, b, c)", "GREATEST(a, b, c)"],
    ["SQRT(amount)", "SQRT(amount)"],
    ["MD5(name)", "MD5(name)"],
    ["CONCAT_WS(',', a, b)", "CONCAT_WS(',', a, b)"],

    // complex
    [
      "CASE WHEN COUNT_IF(is_dau) > 0 THEN 'active' ELSE 'inactive' END",
      "CASE WHEN COUNT_IF(is_dau) > 0 THEN 'active' ELSE 'inactive' END",
    ],
  ];

  for (const [input, expected] of cases) {
    it(`${input}`, () => {
      const result = roundtrip(input);
      expect(result).toBe(expected);
    });
  }
});
