"use server";

import { parse, check, dataType } from "@eloquio/lattik-expression";
import type { SchemaContext } from "@eloquio/lattik-expression";

interface ColumnDef {
  name: string;
  type: string;
}

function toScalarType(type: string) {
  switch (type) {
    case "int32": return "int32" as const;
    case "int64": return "int64" as const;
    case "float": return "float" as const;
    case "double": return "double" as const;
    case "boolean": return "boolean" as const;
    case "timestamp": return "timestamp" as const;
    case "date": return "date" as const;
    case "json": return "json" as const;
    default: return "string" as const;
  }
}

export async function validateExpression(
  expr: string,
  columns?: ColumnDef[]
): Promise<{
  valid: boolean;
  errors: { message: string; position?: number }[];
  resultType?: string;
}> {
  if (!expr || expr.trim().length === 0) {
    return { valid: false, errors: [{ message: "Expression is empty" }] };
  }

  const parseResult = parse(expr);
  if (parseResult.errors.length > 0) {
    return {
      valid: false,
      errors: parseResult.errors.map((e) => ({
        message: e.message,
        position: e.col,
      })),
    };
  }

  if (!parseResult.expr) {
    return { valid: false, errors: [{ message: "Failed to parse expression" }] };
  }

  // If columns provided, run type checking
  if (columns && columns.length > 0) {
    const schema: SchemaContext = {
      columns: columns.map((c) => ({
        name: c.name,
        dataType: dataType(toScalarType(c.type), true),
      })),
    };

    const checkResult = check(parseResult.expr, schema);
    if (checkResult.errors.length > 0) {
      return {
        valid: false,
        errors: checkResult.errors.map((e) => ({
          message: e.message,
          position: e.loc ? e.loc.startCol : undefined,
        })),
      };
    }

    return {
      valid: true,
      errors: [],
      resultType: checkResult.expr.dataType
        ? `${checkResult.expr.dataType.scalar}${checkResult.expr.dataType.nullable ? "?" : ""}`
        : undefined,
    };
  }

  return { valid: true, errors: [] };
}
