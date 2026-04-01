import { z } from "zod";

export const columnTypeSchema = z.enum([
  "string",
  "int32",
  "int64",
  "float",
  "double",
  "boolean",
  "timestamp",
  "date",
  "json",
]);

export const entitySchema = z.object({
  name: z.string(),
  type: z.enum(["string", "int32", "int64"]),
  description: z.string().optional(),
});

export const loggerColumnSchema = z.object({
  name: z.string(),
  type: columnTypeSchema,
  entity: z.string().optional(),
  nullable: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const primaryKeySchema = z.object({
  column: z.string(),
  entity: z.string(),
});

export const loggerTableSchema = z.object({
  name: z.string(),
  event_timestamp: z.string(),
  retention: z.string().optional(),
  dedup_window: z.string().optional(),
  columns: z.array(loggerColumnSchema),
  primary_key: z.array(primaryKeySchema),
});

export const familyColumnSchema = z.object({
  name: z.string(),
  type: columnTypeSchema.optional(),
  agg: z.string().optional(),
  merge: z.enum(["sum", "max", "min", "replace"]).optional(),
  expr: z.string().optional(),
  description: z.string().optional(),
});

export const columnFamilySchema = z.object({
  name: z.string(),
  source: z.string(),
  key_mapping: z.record(z.string(), z.string()),
  columns: z.array(familyColumnSchema),
});

export const derivedColumnSchema = z.object({
  name: z.string(),
  expr: z.string(),
  description: z.string().optional(),
});

export const lattikTableSchema = z.object({
  name: z.string(),
  primary_key: z.array(primaryKeySchema),
  column_families: z.array(columnFamilySchema),
  derived_columns: z.array(derivedColumnSchema).optional(),
});

export const pipelineDefinitionSchema = z.object({
  version: z.literal(1),
  entities: z.array(entitySchema),
  log_tables: z.array(loggerTableSchema),
  tables: z.array(lattikTableSchema),
});

export type Entity = z.infer<typeof entitySchema>;
export type LoggerColumn = z.infer<typeof loggerColumnSchema>;
export type LoggerTable = z.infer<typeof loggerTableSchema>;
export type ColumnFamily = z.infer<typeof columnFamilySchema>;
export type LattikTable = z.infer<typeof lattikTableSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;
