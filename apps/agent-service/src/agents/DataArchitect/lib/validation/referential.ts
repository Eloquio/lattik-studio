import type { ValidationError } from "./naming";
import { listMergedDefinitions } from "../definitions.js";
import {
  entitySchema,
  dimensionSchema,
  loggerTableSchema,
  lattikTableSchema,
  type Entity,
  type Dimension,
  type LoggerTable,
  type LattikTable,
} from "../schema";
import type { z } from "zod";

/**
 * Defensively parse stored definition specs through their Zod schemas. Specs
 * are persisted as untyped JSONB, so a corrupted row, a stale schema, or a
 * legacy entry could otherwise be cast to the expected shape and crash a
 * downstream validator with a confusing TypeError. We log and skip malformed
 * rows so the rest of the workspace context survives.
 */
function safeParseAll<S extends z.ZodTypeAny>(
  schema: S,
  rows: Array<{ id: string; spec: unknown }>,
  kind: string
): Array<z.infer<S>> {
  const out: Array<z.infer<S>> = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row.spec);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      console.warn(
        `[validation] Skipping malformed ${kind} definition ${row.id}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }
  }
  return out;
}

/**
 * Validators must see EVERY merged definition to catch real conflicts. The
 * default `listMergedDefinitions` limit of 100 is fine for the UI but would
 * silently truncate referential context here, so we explicitly request the
 * maximum. If a workspace genuinely exceeds 1000 definitions of a single
 * kind, we log a warning so we notice instead of half-validating.
 */
const REFERENTIAL_LIMIT = 1000;

function warnIfTruncated(rows: unknown[], kind: string) {
  if (rows.length >= REFERENTIAL_LIMIT) {
    console.warn(
      `[validation] Referential context for ${kind} hit the ${REFERENTIAL_LIMIT}-row limit. Validation may miss conflicts — raise REFERENTIAL_LIMIT or paginate.`
    );
  }
}

// Short-TTL in-process cache. The validation/review flow runs staticCheck →
// review → staticCheck back-to-back, each independently calling `loadMerged*`
// — without a cache that's 6+ identical DB hits + Zod parses in a few
// seconds. A 30s TTL covers the entire flow with one window and is short
// enough that newly-merged definitions show up promptly in subsequent calls.
const CACHE_TTL_MS = 30_000;
type Cached<T> = { value: T; expiresAt: number };
const cache = new Map<string, Cached<unknown>>();

function memoTtl<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  const promise = fn();
  void promise.then(
    (value) => {
      cache.set(key, { value: value as unknown, expiresAt: Date.now() + ttlMs });
    },
    () => {
      // Don't cache failures — let the next call retry.
    },
  );
  return promise;
}

/** Clear the referential cache. Call after a merge webhook commits new
 *  definitions if you need them visible to validators immediately, rather
 *  than waiting out the 30s TTL. */
export function invalidateMergedDefinitionsCache() {
  cache.clear();
}

export async function loadMergedEntities(): Promise<Entity[]> {
  return memoTtl("entities", CACHE_TTL_MS, async () => {
    const defs = await listMergedDefinitions("entity", REFERENTIAL_LIMIT);
    warnIfTruncated(defs, "entity");
    return safeParseAll(entitySchema, defs, "entity");
  });
}

export async function loadMergedDimensions(): Promise<Dimension[]> {
  return memoTtl("dimensions", CACHE_TTL_MS, async () => {
    const defs = await listMergedDefinitions("dimension", REFERENTIAL_LIMIT);
    warnIfTruncated(defs, "dimension");
    return safeParseAll(dimensionSchema, defs, "dimension");
  });
}

export function validateDimensionExists(
  dimensionName: string,
  mergedDimensions: Dimension[],
  field: string
): ValidationError[] {
  if (!mergedDimensions.some((d) => d.name === dimensionName)) {
    return [{ field, message: `Dimension '${dimensionName}' does not exist in merged definitions` }];
  }
  return [];
}

export async function loadMergedTables(): Promise<{ loggerTables: LoggerTable[]; lattikTables: LattikTable[] }> {
  return memoTtl("tables", CACHE_TTL_MS, async () => {
    const [logDefs, tableDefs] = await Promise.all([
      listMergedDefinitions("logger_table", REFERENTIAL_LIMIT),
      listMergedDefinitions("lattik_table", REFERENTIAL_LIMIT),
    ]);
    warnIfTruncated(logDefs, "logger_table");
    warnIfTruncated(tableDefs, "lattik_table");
    return {
      loggerTables: safeParseAll(loggerTableSchema, logDefs, "logger_table"),
      lattikTables: safeParseAll(lattikTableSchema, tableDefs, "lattik_table"),
    };
  });
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
