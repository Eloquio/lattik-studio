import type { Classification } from "../../schema";

export interface UserColumn {
  _key: string;
  name: string;
  type: string;
  description?: string;
  dimension?: string;
  classification?: Classification;
  tags?: string[];
}

export interface EntityOption {
  name: string;
  id_field: string;
  id_type: string;
}

export interface SourceTableOption {
  name: string;
  kind: string;
  columns: { name: string; type: string }[];
}

export type TableStatus = "idle" | "loading" | "definition" | "catalog" | "not_found";

export interface DimensionOption {
  name: string;
  entity: string;
  source_table: string;
  source_column: string;
  data_type: string;
  description?: string;
}

export type TabStop = [number, number];
