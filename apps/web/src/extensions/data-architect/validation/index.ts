import type { ValidationError } from "./naming";
import { validateName, validateDescription, validateRetention, validateDedupWindow } from "./naming";
import { validateExpression } from "./expressions";
import {
  loadMergedEntities,
  loadMergedTables,
  validateEntityExists,
  validateTableExists,
  validateColumnExists,
} from "./referential";
import type { DefinitionKind } from "@/db/schema";
import type {
  Entity,
  Dimension,
  LoggerTable,
  LattikTable,
  Metric,
} from "../schema";

export type { ValidationError };

export async function validate(
  kind: DefinitionKind,
  spec: unknown
): Promise<{ passed: boolean; errors: ValidationError[] }> {
  const errors: ValidationError[] = [];

  switch (kind) {
    case "entity":
      errors.push(...validateEntity(spec as Entity));
      break;
    case "dimension":
      errors.push(...(await validateDimension(spec as Dimension)));
      break;
    case "logger_table":
      errors.push(...(await validateLoggerTable(spec as LoggerTable)));
      break;
    case "lattik_table":
      errors.push(...(await validateLattikTable(spec as LattikTable)));
      break;
    case "metric":
      errors.push(...(await validateMetric(spec as Metric)));
      break;
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

  const entities = await loadMergedEntities();
  errors.push(...validateEntityExists(spec.entity, entities, "entity"));

  const { loggerTables, lattikTables } = await loadMergedTables();
  errors.push(...validateTableExists(spec.source_table, loggerTables, lattikTables, "source_table"));
  errors.push(...validateColumnExists(spec.source_table, spec.source_column, loggerTables, lattikTables, "source_column"));

  return errors;
}

async function validateLoggerTable(spec: LoggerTable): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  errors.push(...validateName(spec.name, "name"));
  errors.push(...validateRetention(spec.retention, "retention"));
  errors.push(...validateDedupWindow(spec.dedup_window, "dedup_window"));

  // event_timestamp must exist
  if (!spec.columns.some((c) => c.name === spec.event_timestamp)) {
    errors.push({ field: "event_timestamp", message: `event_timestamp column '${spec.event_timestamp}' not found in columns` });
  } else {
    const tsCol = spec.columns.find((c) => c.name === spec.event_timestamp);
    if (tsCol && tsCol.type !== "timestamp") {
      errors.push({ field: "event_timestamp", message: "event_timestamp column must have type 'timestamp'" });
    }
  }

  // Primary key validation
  if (!spec.primary_key || spec.primary_key.length === 0) {
    errors.push({ field: "primary_key", message: "At least one primary key is required" });
  }
  const entities = await loadMergedEntities();
  for (const pk of spec.primary_key) {
    if (!spec.columns.some((c) => c.name === pk.column)) {
      errors.push({ field: "primary_key", message: `PK column '${pk.column}' not found in columns` });
    }
    errors.push(...validateEntityExists(pk.entity, entities, `primary_key.${pk.column}.entity`));
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

  const entities = await loadMergedEntities();
  for (const pk of spec.primary_key) {
    errors.push(...validateEntityExists(pk.entity, entities, `primary_key.${pk.column}.entity`));
  }

  const { loggerTables, lattikTables } = await loadMergedTables();
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

      if (col.agg) {
        errors.push(...validateExpression(col.agg, `family.${family.name}.column.${col.name}.agg`));
        if (!col.merge) {
          errors.push({ field: `family.${family.name}.column.${col.name}.merge`, message: "Columns with agg must specify a merge strategy" });
        }
      }
      if (col.expr) {
        errors.push(...validateExpression(col.expr, `family.${family.name}.column.${col.name}.expr`));
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

  const { loggerTables, lattikTables } = await loadMergedTables();
  for (let i = 0; i < (spec.calculations ?? []).length; i++) {
    const calc = spec.calculations[i];
    errors.push(...validateExpression(calc.expression, `calculations[${i}].expression`));
    errors.push(...validateTableExists(calc.source_table, loggerTables, lattikTables, `calculations[${i}].source_table`));
  }

  return errors;
}
