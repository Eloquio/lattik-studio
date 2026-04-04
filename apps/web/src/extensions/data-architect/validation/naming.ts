export interface ValidationError {
  field: string;
  message: string;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const RESERVED_WORDS = new Set([
  "select", "from", "where", "insert", "update", "delete", "create", "drop",
  "alter", "table", "index", "view", "database", "schema", "grant", "revoke",
  "null", "true", "false", "and", "or", "not", "in", "between", "like",
  "is", "as", "on", "join", "left", "right", "inner", "outer", "group",
  "order", "by", "having", "limit", "offset", "union", "all", "distinct",
  "case", "when", "then", "else", "end", "cast", "exists",
]);

export function validateName(
  value: string,
  field: string,
  { minLength = 1, maxLength = 60 }: { minLength?: number; maxLength?: number } = {}
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!value || value.length < minLength) {
    errors.push({ field, message: `${field} is required (min ${minLength} chars)` });
    return errors;
  }

  if (value.length > maxLength) {
    errors.push({ field, message: `${field} must be at most ${maxLength} chars` });
  }

  if (!SNAKE_CASE_RE.test(value)) {
    errors.push({ field, message: `${field} must be snake_case (lowercase letters, digits, underscores)` });
  }

  if (RESERVED_WORDS.has(value.toLowerCase())) {
    errors.push({ field, message: `${field} '${value}' is a reserved word` });
  }

  return errors;
}

export function validateDescription(
  value: string | undefined,
  field: string,
  { minLength = 10, maxLength = 500 }: { minLength?: number; maxLength?: number } = {}
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!value || value.trim().length < minLength) {
    errors.push({ field, message: `${field} is required (min ${minLength} chars)` });
  } else if (value.length > maxLength) {
    errors.push({ field, message: `${field} must be at most ${maxLength} chars` });
  }

  return errors;
}

export function validateRetention(value: string | undefined, field: string): ValidationError[] {
  if (!value) return [];
  if (!/^\d+[dhmy]$/.test(value)) {
    return [{ field, message: `${field} must be a number followed by d, h, m, or y (e.g. '90d')` }];
  }
  return [];
}

export function validateDedupWindow(value: string | undefined, field: string): ValidationError[] {
  if (!value) return [];
  if (!/^\d+[dhms]$/.test(value)) {
    return [{ field, message: `${field} must be a number followed by d, h, m, or s (e.g. '1h')` }];
  }
  return [];
}
