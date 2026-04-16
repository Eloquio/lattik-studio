import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parse.js";
import { check } from "../src/checker/check.js";
import type { SchemaContext } from "../src/checker/schema.js";
import { dataType } from "../src/ast/data-types.js";

const schema: SchemaContext = {
  columns: [
    { name: "amount", dataType: dataType("double", false) },
    { name: "revenue", dataType: dataType("double", false) },
    { name: "cost", dataType: dataType("int64", false) },
    { name: "quantity", dataType: dataType("int32", false) },
    { name: "name", dataType: dataType("string", false) },
    { name: "status", dataType: dataType("string", false) },
    { name: "active", dataType: dataType("boolean", false) },
    { name: "created_at", dataType: dataType("timestamp", false) },
    { name: "price", dataType: dataType("float", true) },
    { name: "user_id", dataType: dataType("int64", false) },
  ],
};

function checkExpr(input: string, ctx: SchemaContext = schema) {
  const parsed = parse(input);
  expect(parsed.errors).toEqual([]);
  return check(parsed.expr!, ctx);
}

describe("check", () => {
  describe("column resolution", () => {
    it("resolves known column", () => {
      const result = checkExpr("amount");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType).toEqual(dataType("double", false));
    });

    it("reports unknown column", () => {
      const result = checkExpr("nonexistent");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("UNKNOWN_COLUMN");
    });
  });

  describe("arithmetic type inference", () => {
    it("int32 + int32 = int32", () => {
      const result = checkExpr("quantity + quantity");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });

    it("int32 + int64 = int64 (promotion)", () => {
      const result = checkExpr("quantity + cost");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("int64 + double = double (promotion)", () => {
      const result = checkExpr("cost + amount");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("string + int = error", () => {
      const result = checkExpr("name + quantity");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("TYPE_MISMATCH");
    });

    it("string || string = string", () => {
      const result = checkExpr("name || status");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("string");
    });
  });

  describe("comparison", () => {
    it("a > 0 = boolean", () => {
      const result = checkExpr("amount > 0");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("boolean");
    });
  });

  describe("nullability propagation", () => {
    it("nullable + non-nullable = nullable", () => {
      const result = checkExpr("price + quantity");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.nullable).toBe(true);
    });

    it("IS NULL always non-nullable boolean", () => {
      const result = checkExpr("price IS NULL");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType).toEqual(dataType("boolean", false));
    });
  });

  describe("CASE type unification", () => {
    it("CASE with compatible branches", () => {
      const result = checkExpr(
        "CASE WHEN active THEN quantity ELSE cost END"
      );
      expect(result.errors).toEqual([]);
      // int32 + int64 → int64
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("CASE without ELSE is nullable", () => {
      const result = checkExpr("CASE WHEN active THEN quantity END");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.nullable).toBe(true);
    });
  });

  describe("CAST", () => {
    it("CAST sets target type", () => {
      const result = checkExpr("CAST(quantity AS DOUBLE)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });
  });

  describe("function calls", () => {
    it("COALESCE returns non-nullable", () => {
      const result = checkExpr("COALESCE(price, 0)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.nullable).toBe(false);
    });

    it("LOWER returns string", () => {
      const result = checkExpr("LOWER(name)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("string");
    });

    it("unknown function reports error", () => {
      const result = checkExpr("FOOBAR(amount)");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("UNKNOWN_FUNCTION");
    });

    it("wrong arg count reports error", () => {
      const result = checkExpr("ABS(1, 2)");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("ARG_COUNT");
    });
  });

  describe("aggregates", () => {
    it("COUNT(*) = int64", () => {
      const result = checkExpr("COUNT(*)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType).toEqual(dataType("int64", false));
    });

    it("SUM(int32) = int64", () => {
      const result = checkExpr("SUM(quantity)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("SUM(double) = double", () => {
      const result = checkExpr("SUM(amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("AVG always returns double", () => {
      const result = checkExpr("AVG(quantity)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });
  });

  describe("window functions", () => {
    it("window inherits inner function type", () => {
      const result = checkExpr(
        "SUM(amount) OVER (PARTITION BY user_id)"
      );
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("ROW_NUMBER returns int64", () => {
      const result = checkExpr("ROW_NUMBER() OVER (ORDER BY amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("RANK returns int32", () => {
      const result = checkExpr("RANK() OVER (ORDER BY amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });

    it("LAG returns argument type", () => {
      const result = checkExpr("LAG(amount, 1) OVER (ORDER BY created_at)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("NTILE returns int32", () => {
      const result = checkExpr("NTILE(4) OVER (ORDER BY amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });

    it("CUME_DIST returns double", () => {
      const result = checkExpr("CUME_DIST() OVER (ORDER BY amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });
  });

  describe("conditional aggregates", () => {
    it("COUNT_IF returns int64", () => {
      const result = checkExpr("COUNT_IF(active)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType).toEqual(dataType("int64", false));
    });

    it("COUNT_IF requires boolean argument", () => {
      const result = checkExpr("COUNT_IF(amount)");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("TYPE_MISMATCH");
    });

    it("SUM_IF preserves int64 type", () => {
      const result = checkExpr("SUM_IF(cost, active)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("SUM_IF preserves double type", () => {
      const result = checkExpr("SUM_IF(amount, active)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("SUM_IF requires boolean second arg", () => {
      const result = checkExpr("SUM_IF(amount, cost)");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("TYPE_MISMATCH");
    });

    it("AVG_IF returns double", () => {
      const result = checkExpr("AVG_IF(quantity, active)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("AVG_IF requires boolean second arg", () => {
      const result = checkExpr("AVG_IF(amount, name)");
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("spark aggregates", () => {
    it("MIN passes through type", () => {
      const result = checkExpr("MIN(amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("MAX passes through type", () => {
      const result = checkExpr("MAX(quantity)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });

    it("FIRST passes through type", () => {
      const result = checkExpr("FIRST(name)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("string");
    });

    it("COLLECT_LIST returns json", () => {
      const result = checkExpr("COLLECT_LIST(name)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("json");
    });

    it("STDDEV returns double", () => {
      const result = checkExpr("STDDEV(amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("APPROX_COUNT_DISTINCT returns int64", () => {
      const result = checkExpr("APPROX_COUNT_DISTINCT(user_id)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType).toEqual(dataType("int64", false));
    });

    it("PERCENTILE returns double", () => {
      const result = checkExpr("PERCENTILE(amount, 0.5)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });
  });

  describe("spark scalar functions", () => {
    it("YEAR returns int32", () => {
      const result = checkExpr("YEAR(created_at)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });

    it("DATE_ADD returns date", () => {
      const result = checkExpr("DATE_ADD(created_at, 7)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("date");
    });

    it("REPLACE returns string", () => {
      const result = checkExpr("REPLACE(name, 'a', 'b')");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("string");
    });

    it("GREATEST returns promoted type", () => {
      const result = checkExpr("GREATEST(quantity, cost)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int64");
    });

    it("NVL returns non-nullable", () => {
      const result = checkExpr("NVL(price, 0)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.nullable).toBe(false);
    });

    it("MD5 returns string", () => {
      const result = checkExpr("MD5(name)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("string");
    });

    it("SQRT returns double", () => {
      const result = checkExpr("SQRT(amount)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("SIZE returns int32", () => {
      const result = checkExpr("SIZE(name)");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("int32");
    });
  });

  describe("unary minus validation", () => {
    it("unary minus on number is ok", () => {
      const result = checkExpr("-amount");
      expect(result.errors).toEqual([]);
      expect(result.expr.dataType?.scalar).toBe("double");
    });

    it("unary minus on string is error", () => {
      const result = checkExpr("-name");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("TYPE_MISMATCH");
    });
  });

  describe("filter clause validation", () => {
    it("FILTER with boolean is ok", () => {
      const result = checkExpr("SUM(amount) FILTER (WHERE active)");
      expect(result.errors).toEqual([]);
    });

    it("FILTER with non-boolean is error", () => {
      const result = checkExpr("SUM(amount) FILTER (WHERE quantity)");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("TYPE_MISMATCH");
    });
  });
});
