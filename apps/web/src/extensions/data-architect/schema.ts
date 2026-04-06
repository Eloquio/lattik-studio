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
  description: z.string(),
  id_field: z.string(),
  id_type: z.enum(["int64", "string"]),
});

export const loggerColumnSchema = z.object({
  name: z.string(),
  type: columnTypeSchema,
  dimension: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const primaryKeySchema = z.object({
  column: z.string(),
  entity: z.string(),
});

export const loggerTableSchema = z.object({
  name: z.string(),
  description: z.string(),
  retention: z.string().optional().default("30d"),
  dedup_window: z.string().optional().default("1h"),
  columns: z.array(loggerColumnSchema),
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
  description: z.string(),
  primary_key: z.array(primaryKeySchema),
  column_families: z.array(columnFamilySchema),
  derived_columns: z.array(derivedColumnSchema).optional(),
});

export const dimensionSchema = z.object({
  name: z.string(),
  description: z.string(),
  entity: z.string(),
  source_table: z.string(),
  source_column: z.string(),
  data_type: columnTypeSchema,
});

export const metricCalculationSchema = z.object({
  expression: z.string(),
  source_table: z.string(),
});

export const metricSchema = z.object({
  name: z.string(),
  description: z.string(),
  calculations: z.array(metricCalculationSchema),
});

export const pipelineDefinitionSchema = z.object({
  version: z.literal(1),
  entities: z.array(entitySchema),
  dimensions: z.array(dimensionSchema).optional(),
  log_tables: z.array(loggerTableSchema),
  tables: z.array(lattikTableSchema),
  metrics: z.array(metricSchema).optional(),
});

export type Entity = z.infer<typeof entitySchema>;
export type LoggerColumn = z.infer<typeof loggerColumnSchema>;
export type LoggerTable = z.infer<typeof loggerTableSchema>;
export type ColumnFamily = z.infer<typeof columnFamilySchema>;
export type LattikTable = z.infer<typeof lattikTableSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export type MetricCalculation = z.infer<typeof metricCalculationSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;
