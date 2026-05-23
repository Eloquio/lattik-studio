import type { z } from "zod";
import type { ValidationError } from "./naming";
import { validateName, validateQualifiedName, validateDescription, validateRetention, validateDedupWindow } from "./naming";
import { validateExpression } from "./expressions";
import {
  loadMergedEntityNames,
  loadMergedDimensionNames,
  loadMergedTableNames,
  loadMergedTables,
  validateEntityExists,
  validateDimensionExists,
  validateTableExists,
  validateColumnExists,
} from "./referential";
import type { DefinitionKind } from "@eloquio/db-schema";
import {
  entitySchema,
  dimensionSchema,
  loggerTableSchema,
  lattikTableSchema,
  metricSchema,
  type Entity,
  type Dimension,
  type LoggerTable,
  type LattikTable,
  type Metric,
} from "../schema";

export type { ValidationError };

const SCHEMAS = {
  entity: entitySchema,
  dimension: dimensionSchema,
  logger_table: loggerTableSchema,
  lattik_table: lattikTableSchema,
  metric: metricSchema,
} as const;

function zodIssuesToValidationErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

export async function validate(
  kind: DefinitionKind,
  spec: unknown
): Promise<{ passed: boolean; errors: ValidationError[] }> {
  // Shape check via Zod first. This guarantees the per-kind validators below
  // see well-typed input and never crash on missing fields — any structural
  // problems become structured errors instead of thrown exceptions.
  const schema = SCHEMAS[kind];
  const parsed = schema.safeParse(spec);
  if (!parsed.success) {
    return { passed: false, errors: zodIssuesToValidationErrors(parsed.error) };
  }

  const errors: ValidationError[] = [];

  try {
    switch (kind) {
      case "entity":
        errors.push(...validateEntity(parsed.data as Entity));
        break;
      case "dimension":
        errors.push(...(await validateDimension(parsed.data as Dimension)));
        break;
      case "logger_table":
        errors.push(...(await validateLoggerTable(parsed.data as LoggerTable)));
        break;
      case "lattik_table":
        errors.push(...(await validateLattikTable(parsed.data as LattikTable)));
        break;
      case "metric":
        errors.push(...(await validateMetric(parsed.data as Metric)));
        break;
    }
  } catch (e) {
    // Last-resort safety net: an unexpected runtime error (e.g. a referential
    // loader failing) becomes a structured validation error so the agent can
    // recover instead of the tool call crashing.
    errors.push({
      field: "(root)",
      message: `Unexpected validation error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return { passed: errors.length === 0, errors };
}

function validateEntity(spec: Entity): ValidationError[] {
  const errors: ValidationError[] = [];
  errors.push(...validateName(spec.name, "name"));
  errors.push(...validateDescription(spec.description, "description"));
  if (!spec.id_field || !spec.id_field.endsWith("_id")) {
    errors.push({ field: "id_field", message: "ID field must end with '_id'" });
  } else {
    errors.push(...validateName(spec.id_field, "id_field"));
  }
  if (!["int64", "string"].includes(spec.id_type)) {
    errors.push({ field: "id_type", message: "ID type must be 'int64' or 'string'" });
  }
  return errors;
}

async function validateDimension(spec: Dimension): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  errors.push(...validateName(spec.name, "name"));
  errors.push(...validateDescription(spec.description, "description"));

  // Entity check is existence-only — fetch names without Zod-parsing every
  // merged entity. Table check uses the full parses because validateColumnExists
  // walks columns/families.
  const [entityNames, { loggerTables, lattikTables }] = await Promise.all([
    loadMergedEntityNames(),
    loadMergedTables(),
  ]);
  errors.push(...validateEntityExists(spec.entity, entityNames, "entity"));
  errors.push(...validateTableExists(spec.source_table, loggerTables, lattikTables, "source_table"));
  errors.push(...validateColumnExists(spec.source_table, spec.source_column, loggerTables, lattikTables, "source_column"));

  return errors;
}

async function validateLoggerTable(spec: LoggerTable): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  errors.push(...validateQualifiedName(spec.name, "name"));
  errors.push(...validateDescription(spec.description, "description"));
  errors.push(...validateRetention(spec.retention, "retention"));
  errors.push(...validateDedupWindow(spec.dedup_window, "dedup_window"));

  // User-defined columns must not collide with implicit columns
  const IMPLICIT_COLUMNS = new Set(["event_id", "event_timestamp", "ds", "hour"]);
  for (const col of spec.columns) {
    if (IMPLICIT_COLUMNS.has(col.name)) {
      errors.push({ field: `column.${col.name}`, message: `'${col.name}' is an implicit column and cannot be redefined` });
    }
  }

  // Dimension references must exist — names-only path skips the Zod parse
  // over every merged dimension's spec.
  const dimensionNames = await loadMergedDimensionNames();
  for (const col of spec.columns) {
    if (col.dimension) {
      errors.push(...validateDimensionExists(col.dimension, dimensionNames, `column.${col.name}.dimension`));
    }
  }

  // Column names unique and valid
  const colNames = new Set<string>();
  for (const col of spec.columns) {
    errors.push(...validateName(col.name, `column.${col.name}`));
    if (colNames.has(col.name)) {
      errors.push({ field: `column.${col.name}`, message: `Duplicate column name '${col.name}'` });
    }
    colNames.add(col.name);
  }

  return errors;
}

async function validateLattikTable(spec: LattikTable): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  errors.push(...validateName(spec.name, "name"));

  if (!spec.primary_key || spec.primary_key.length === 0) {
    errors.push({ field: "primary_key", message: "At least one primary key is required" });
  }

  // Entity refs are existence-only; tables are needed in full because
  // validateColumnExists walks columns/families. Fire in parallel.
  const [entityNames, mergedTables] = await Promise.all([
    loadMergedEntityNames(),
    loadMergedTables(),
  ]);
  for (const pk of spec.primary_key) {
    errors.push(...validateEntityExists(pk.entity, entityNames, `primary_key.${pk.column}.entity`));
  }

  const { loggerTables, lattikTables } = mergedTables;
  const allColNames = new Set<string>();

  for (const family of spec.column_families) {
    errors.push(...validateName(family.name, `family.${family.name}`));
    errors.push(...validateTableExists(family.source, loggerTables, lattikTables, `family.${family.name}.source`));

    for (const col of family.columns) {
      errors.push(...validateName(col.name, `family.${family.name}.column.${col.name}`));
      if (allColNames.has(col.name)) {
        errors.push({ field: `family.${family.name}.column.${col.name}`, message: `Duplicate column name '${col.name}'` });
      }
      allColNames.add(col.name);

      const prefix = `family.${family.name}.column.${col.name}`;
      switch (col.strategy) {
        case "lifetime_window":
          errors.push(...validateExpression(col.agg, `${prefix}.agg`));
          break;
        case "prepend_list":
          errors.push(...validateExpression(col.expr, `${prefix}.expr`));
          if (col.max_length < 1) {
            errors.push({ field: `${prefix}.max_length`, message: "max_length must be at least 1" });
          }
          break;
        case "bitmap_activity":
          if (col.window < 1) {
            errors.push({ field: `${prefix}.window`, message: "window must be at least 1" });
          }
          break;
      }
    }
  }

  for (const dc of spec.derived_columns ?? []) {
    errors.push(...validateName(dc.name, `derived.${dc.name}`));
    if (allColNames.has(dc.name)) {
      errors.push({ field: `derived.${dc.name}`, message: `Duplicate column name '${dc.name}'` });
    }
    allColNames.add(dc.name);
    errors.push(...validateExpression(dc.expr, `derived.${dc.name}.expr`));
  }

  return errors;
}

async function validateMetric(spec: Metric): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  errors.push(...validateName(spec.name, "name"));
  errors.push(...validateDescription(spec.description, "description"));

  if (!spec.calculations || spec.calculations.length === 0) {
    errors.push({ field: "calculations", message: "At least one calculation is required" });
  }

  // Metric check is existence-only on tables (no column-level inspection),
  // so use the names-only loader to skip the LoggerTable/LattikTable Zod parse.
  const { loggerTableNames, lattikTableNames } = await loadMergedTableNames();
  for (let i = 0; i < (spec.calculations ?? []).length; i++) {
    const calc = spec.calculations[i];
    errors.push(...validateExpression(calc.expression, `calculations[${i}].expression`));
    errors.push(...validateTableExists(calc.source_table, loggerTableNames, lattikTableNames, `calculations[${i}].source_table`));
  }

  return errors;
}
