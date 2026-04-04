import { parse } from "@eloquio/lattik-expression";
import type { ValidationError } from "./naming";

/**
 * Validate a lattik-expression string using the real parser.
 */
export function validateExpression(
  expr: string,
  field: string
): ValidationError[] {
  if (!expr || expr.trim().length === 0) {
    return [{ field, message: `${field} expression is required` }];
  }

  const result = parse(expr);
  if (result.errors.length > 0) {
    return result.errors.map((e) => ({
      field,
      message: `${field}: ${e.message} (line ${e.line}, col ${e.col})`,
    }));
  }

  return [];
}
