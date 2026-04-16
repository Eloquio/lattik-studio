# [@eloquio/lattik-expression](https://github.com/Eloquio/lattik-expression)

A TypeScript library for parsing, type-checking, and emitting SQL expressions. Built for data pipeline tools that need to validate user-written expressions against a known schema before execution.

Part of the [Lattik](https://github.com/Eloquio/lattik) open-source data platform by [Eloquio](https://github.com/Eloquio).

## Install

```bash
npm install @eloquio/lattik-expression
```

## Quick start

```typescript
import { parse, check, emitSql, dataType } from "@eloquio/lattik-expression";

// 1. Parse an expression string into an AST
const { expr, errors } = parse("SUM(amount) FILTER (WHERE active)");

if (errors.length > 0) {
  console.error("Parse errors:", errors);
} else {
  // 2. Type-check against your schema
  const result = check(expr, {
    columns: [
      { name: "amount", dataType: dataType("double", false) },
      { name: "active", dataType: dataType("boolean", false) },
    ],
  });

  if (result.errors.length > 0) {
    console.error("Type errors:", result.errors);
  } else {
    console.log(result.expr.dataType);
    // → { scalar: "double", nullable: true }

    // 3. Emit back to SQL
    console.log(emitSql(result.expr));
    // → 'SUM(amount) FILTER (WHERE active)'
  }
}
```

That's it. Three functions: `parse`, `check`, `emitSql`.

## What it supports

The expression language covers standard SQL expression syntax used in data pipelines:

**Basics** -- column references, literals (int, float, string, boolean, null), arithmetic (`+`, `-`, `*`, `/`, `%`), string concatenation (`||`), comparisons, logical operators (`AND`, `OR`, `NOT`).

**Predicates** -- `IS [NOT] NULL`, `[NOT] BETWEEN ... AND ...`, `[NOT] IN (...)`, `[NOT] LIKE`.

**CASE / CAST** -- both simple and searched CASE expressions, CAST to any supported type.

**140+ built-in functions** -- full Spark SQL compatibility:

| Category | Examples |
|----------|---------|
| Math | `ABS`, `ROUND`, `POW`, `SQRT`, `LOG`, `GREATEST`, `LEAST`, `MOD` |
| String | `LOWER`, `UPPER`, `TRIM`, `REPLACE`, `REGEXP_REPLACE`, `SPLIT`, `CONCAT_WS`, `LPAD` |
| Date/time | `YEAR`, `MONTH`, `DAY`, `DATE_ADD`, `DATEDIFF`, `DATE_FORMAT`, `TO_TIMESTAMP` |
| Null handling | `COALESCE`, `NVL`, `NVL2`, `IFNULL`, `IF` |
| Hash | `MD5`, `SHA1`, `SHA2`, `CRC32`, `XXHASH64` |
| Array | `SIZE`, `ARRAY_CONTAINS`, `EXPLODE`, `FLATTEN`, `SORT_ARRAY` |
| JSON | `GET_JSON_OBJECT`, `FROM_JSON`, `TO_JSON` |
| Type conversion | `INT`, `BIGINT`, `FLOAT`, `DOUBLE`, `STRING`, `DATE`, `TIMESTAMP` |

**19 aggregate functions** -- `SUM`, `COUNT`, `AVG`, `MIN`, `MAX`, `FIRST`, `LAST`, `COUNT_DISTINCT`, `STDDEV`, `VARIANCE`, `COLLECT_LIST`, `COLLECT_SET`, `COUNT_IF`, `SUM_IF`, `AVG_IF`, `PERCENTILE`, `PERCENTILE_APPROX`, `APPROX_COUNT_DISTINCT`, `ANY_VALUE`. All support `DISTINCT` and `FILTER (WHERE ...)`.

**Window functions** -- `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, `CUME_DIST`, `PERCENT_RANK`. Full `OVER (PARTITION BY ... ORDER BY ... ROWS/RANGE ...)` syntax.

## Type system

Expressions are type-checked against a schema you provide. The type checker infers the result type for every node in the AST, validates argument types, and reports errors.

Supported scalar types: `string`, `int32`, `int64`, `float`, `double`, `boolean`, `timestamp`, `date`, `json`.

Every type tracks nullability. Numeric types are automatically promoted (`int32` + `int64` = `int64`, `int32` + `float` = `float`, etc.).

```typescript
import { parse, check, dataType } from "@eloquio/lattik-expression";

const schema = {
  columns: [
    { name: "price", dataType: dataType("float", true) },   // nullable float
    { name: "quantity", dataType: dataType("int32", false) }, // non-nullable int32
  ],
};

const result = check(parse("price * quantity").expr!, schema);
console.log(result.expr.dataType);
// → { scalar: "float", nullable: true }  (promoted to float, nullable because price is nullable)
```

## Custom functions

Register your own functions alongside the 140+ built-ins:

```typescript
import { parse, check, dataType } from "@eloquio/lattik-expression";

const schema = {
  columns: [
    { name: "text", dataType: dataType("string", false) },
  ],
  functions: new Map([
    ["MY_CUSTOM_FN", {
      name: "MY_CUSTOM_FN",
      minArgs: 1,
      maxArgs: 2,
      resolve: (argTypes) => dataType("string", false),
    }],
  ]),
};

const result = check(parse("MY_CUSTOM_FN(text, 'option')").expr!, schema);
// Works -- resolves to string type
```

## Error handling

Both `parse()` and `check()` return errors as data, never throw. Errors include location info for editor integration:

```typescript
const { errors } = parse("SUM(");
// → [{ line: 1, col: 5, message: "Expected RPAREN but got ''" }]

const result = check(parse("unknown_col + 1").expr!, { columns: [] });
// → [{ code: "UNKNOWN_COLUMN", message: "Unknown column 'unknown_col'" }]
```

Error codes from the type checker: `UNKNOWN_COLUMN`, `AMBIGUOUS_COLUMN`, `UNKNOWN_FUNCTION`, `ARG_COUNT`, `TYPE_MISMATCH`.

## AST utilities

Walk or transform the AST:

```typescript
import { parse, walkExpr, mapExpr } from "@eloquio/lattik-expression";

const expr = parse("a + b * c").expr!;

// Walk: visit every node
walkExpr(expr, (node, recurse) => {
  if (node.kind === "ColumnRef") {
    console.log("Found column:", node.column);
  }
  recurse(); // visit children
});

// Transform: rename columns
const renamed = mapExpr(expr, (node) => {
  if (node.kind === "ColumnRef" && node.column === "a") {
    return { ...node, column: "x" };
  }
  return node;
});

console.log(emitSql(renamed)); // → "x + b * c"
```

## Safety limits

The library enforces limits to prevent denial-of-service from untrusted input:

| Limit | Default |
|-------|---------|
| Max input length | 1 MB |
| Max expression nesting depth | 128 |
| Max list items (IN, function args, PARTITION BY, ORDER BY) | 10,000 |
| Max CASE WHEN clauses | 1,000 |
| Max numeric literal length | 100 chars |
| Max string literal / identifier length | 64 KB |

## Roundtrip safety

`parse` → `emitSql` → `parse` → `emitSql` produces identical output. This means you can safely store expressions as strings, parse them, transform them, and emit them back without drift.

## API reference

### `parse(input: string): ParseResult`

Parse an expression string. Returns `{ expr: Expr | null, errors: ParseError[] }`.

### `check(expr: Expr, schema: SchemaContext): CheckResult`

Type-check an AST against a schema. Returns `{ expr: Expr, errors: CheckError[] }`. The returned `expr` has `dataType` populated on every node.

### `emitSql(expr: Expr, options?: EmitOptions): string`

Emit an AST back to a SQL string. Handles operator precedence, parenthesization, string escaping, and keyword quoting.

### `dataType(scalar: ScalarTypeKind, nullable: boolean): DataType`

Create a `DataType` object. Used when defining schema columns and custom function return types.

### `walkExpr(expr, visit)` / `mapExpr(expr, transform)`

Generic AST traversal and transformation utilities.

## Related

- [lattik](https://github.com/Eloquio/lattik) -- monorepo orchestrator
- [lattik-stitch](https://github.com/Eloquio/lattik-stitch) -- columnar stitch engine (Rust + Spark + Trino)
- [lattik-studio](https://github.com/Eloquio/lattik-studio) -- agentic analytics platform (Next.js + AI SDK)

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
