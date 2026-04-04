import type { ValidationError } from "./naming";
import { listMergedDefinitions } from "@/lib/actions/definitions";
import type { Entity, LoggerTable, LattikTable } from "../schema";

export async function loadMergedEntities(): Promise<Entity[]> {
  const defs = await listMergedDefinitions("entity");
  return defs.map((d) => d.spec as Entity);
}

export async function loadMergedTables(): Promise<{ loggerTables: LoggerTable[]; lattikTables: LattikTable[] }> {
  const [logDefs, tableDefs] = await Promise.all([
    listMergedDefinitions("logger_table"),
    listMergedDefinitions("lattik_table"),
  ]);
  return {
    loggerTables: logDefs.map((d) => d.spec as LoggerTable),
    lattikTables: tableDefs.map((d) => d.spec as LattikTable),
  };
}

export function validateEntityExists(
  entityName: string,
  mergedEntities: Entity[],
  field: string
): ValidationError[] {
  if (!mergedEntities.some((e) => e.name === entityName)) {
    return [{ field, message: `Entity '${entityName}' does not exist in merged definitions` }];
  }
  return [];
}

export function validateTableExists(
  tableName: string,
  loggerTables: LoggerTable[],
  lattikTables: LattikTable[],
  field: string
): ValidationError[] {
  const exists =
    loggerTables.some((t) => t.name === tableName) ||
    lattikTables.some((t) => t.name === tableName);
  if (!exists) {
    return [{ field, message: `Table '${tableName}' does not exist in merged definitions` }];
  }
  return [];
}

export function validateColumnExists(
  tableName: string,
  columnName: string,
  loggerTables: LoggerTable[],
  lattikTables: LattikTable[],
  field: string
): ValidationError[] {
  const logTable = loggerTables.find((t) => t.name === tableName);
  if (logTable) {
    if (logTable.columns.some((c) => c.name === columnName)) return [];
    return [{ field, message: `Column '${columnName}' not found in table '${tableName}'` }];
  }

  const latTable = lattikTables.find((t) => t.name === tableName);
  if (latTable) {
    const allCols = [
      ...latTable.column_families.flatMap((f) => f.columns.map((c) => c.name)),
      ...(latTable.derived_columns ?? []).map((c) => c.name),
    ];
    if (allCols.includes(columnName)) return [];
    return [{ field, message: `Column '${columnName}' not found in table '${tableName}'` }];
  }

  return [{ field, message: `Table '${tableName}' not found` }];
}
