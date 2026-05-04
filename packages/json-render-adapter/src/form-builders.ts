import type { Spec } from "@json-render/core";
import { z } from "zod";
import {
  entityFormInitialStateSchema,
  dimensionFormInitialStateSchema,
  loggerTableFormInitialStateSchema,
  lattikTableFormInitialStateSchema,
  metricFormInitialStateSchema,
} from "@eloquio/render-intents";

export {
  entityFormInitialStateSchema,
  dimensionFormInitialStateSchema,
  loggerTableFormInitialStateSchema,
  lattikTableFormInitialStateSchema,
  metricFormInitialStateSchema,
};

/**
 * Per-kind form spec builders.
 *
 * The Data Architect agent used to render forms by free-form generating JSONL
 * spec patches inside a `spec` code fence. That worked but exposed a class of
 * LLM-generation bugs (token-level array repetition loops, missing fields,
 * malformed structure) every time the agent rendered a form. The renderForm
 * tool replaces that pattern: the agent calls the tool with structured initial
 * state, and the canonical Spec is built deterministically from one of the
 * functions in this file. The LLM never produces raw spec patches.
 *
 * Each builder takes initial state matching its form's canvas state shape and
 * returns a complete json-render Spec ready to be applied to the canvas.
 * Defaults match the form components' fallback values exactly so the rendered
 * UI looks the same whether the LLM populates a field or leaves it blank.
 *
 * The `*InitialStateSchema` schemas live in `@eloquio/render-intents` so the
 * agent-service can use the same validators as its tool input schemas.
 */

// ---- Builders ----
//
// Each builder takes a parsed initial state object and returns a complete
// Spec. They generate `_key` fields for array entries (the form components
// use these as React keys) and apply the same field defaults as the form
// components themselves so the rendered UI is consistent regardless of which
// fields the LLM provided.

let _keyCounter = 0;
function nextKey(prefix: string): string {
  _keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_keyCounter}`;
}

function withKeys<T extends object>(
  prefix: string,
  items: ReadonlyArray<T> | undefined
): Array<T & { _key: string }> {
  return (items ?? []).map((item) => ({ ...item, _key: nextKey(prefix) }));
}

export function buildEntityFormSpec(
  s: z.infer<typeof entityFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "EntityForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      id_field: s.id_field ?? "",
      id_type: s.id_type ?? "string",
    },
  };
}

export function buildDimensionFormSpec(
  s: z.infer<typeof dimensionFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "DimensionForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      entity: s.entity ?? "",
      source_table: s.source_table ?? "",
      source_column: s.source_column ?? "",
      data_type: s.data_type ?? "string",
    },
  };
}

export function buildLoggerTableFormSpec(
  s: z.infer<typeof loggerTableFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "LoggerTableForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      retention: s.retention ?? "30d",
      dedup_window: s.dedup_window ?? "1h",
      user_columns: withKeys("col", s.user_columns),
    },
  };
}

export function buildLattikTableFormSpec(
  s: z.infer<typeof lattikTableFormInitialStateSchema>
): Spec {
  // Tag column families and their nested arrays with stable React keys.
  // Derive family name from source if not provided (e.g., "ingest.signups" → "signups").
  const columnFamilies = (s.column_families ?? []).map((cf) => ({
    _key: nextKey("cf"),
    name: cf.name || cf.source.split(".").pop() || cf.source,
    source: cf.source,
    key_mapping: withKeys("km", cf.key_mapping),
    columns: withKeys("fcol", cf.columns),
  }));

  return {
    root: "main",
    elements: {
      main: { type: "LattikTableForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      retention: s.retention ?? "30d",
      primary_key: withKeys("pk", s.primary_key),
      column_families: columnFamilies,
      derived_columns: withKeys("dc", s.derived_columns),
      backfill: {
        lookback: s.backfill?.lookback ?? "30d",
        parallelism: s.backfill?.parallelism ?? 1,
      },
    },
  };
}

export function buildMetricFormSpec(
  s: z.infer<typeof metricFormInitialStateSchema>
): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "MetricForm", props: {}, children: [] },
    },
    state: {
      name: s.name ?? "",
      description: s.description ?? "",
      calculations: withKeys("calc", s.calculations),
    },
  };
}
