export interface ValidationError {
  field: string;
  message: string;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const QUALIFIED_NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

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

export function validateQualifiedName(
  value: string,
  field: string,
  { maxLength = 60 }: { maxLength?: number } = {}
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!value || value.length === 0) {
    errors.push({ field, message: `${field} is required` });
    return errors;
  }

  if (value.length > maxLength) {
    errors.push({ field, message: `${field} must be at most ${maxLength} chars` });
  }

  if (!QUALIFIED_NAME_RE.test(value)) {
    errors.push({ field, message: `${field} must be schema.table_name format (e.g. 'ingest.click_events')` });
  }

  const parts = value.split(".");
  for (const part of parts) {
    if (RESERVED_WORDS.has(part.toLowerCase())) {
      errors.push({ field, message: `${field} contains reserved word '${part}'` });
    }
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
  if (!/^\d+d$/.test(value)) {
    return [{ field, message: `${field} must be a number followed by d (e.g. '30d', '90d')` }];
  }
  return [];
}

export function validateDedupWindow(value: string | undefined, field: string): ValidationError[] {
  if (!value) return [];
  if (!/^\d+h$/.test(value)) {
    return [{ field, message: `${field} must be a number followed by h (e.g. '1h', '24h')` }];
  }
  return [];
}
