import { load as yamlLoad } from "js-yaml";
import type { DefinitionKind } from "@eloquio/db-schema";

// Inverse of KIND_DIRS in agents/DataArchitect/lib/yaml-generator.ts. The
// reconciler keys off the directory name to derive `kind`; if either side
// drifts the merge handler silently stops recognising whole categories of
// files, so this table is the load-bearing contract between authoring and
// reconciliation.
const DIR_TO_KIND: Record<string, DefinitionKind> = {
  entities: "entity",
  dimensions: "dimension",
  logger_tables: "logger_table",
  lattik_tables: "lattik_table",
  metrics: "metric",
};

export interface ParsedDefinitionPath {
  kind: DefinitionKind;
  name: string;
}

export function parseDefinitionPath(path: string): ParsedDefinitionPath | null {
  const m = path.match(/^definitions\/([^/]+)\/([^/]+)\.yaml$/);
  if (!m) return null;
  const kind = DIR_TO_KIND[m[1]];
  if (!kind) return null;
  return { kind, name: m[2] };
}

export function parseDefinitionYaml(raw: string): unknown {
  return yamlLoad(raw);
}
