import type { DefinitionKind } from "@/db/schema";

/**
 * Single source of truth for the canvas-state → definition-spec mapping.
 *
 * The Data Architect canvas forms (LoggerTableForm, LattikTableForm, etc.)
 * store form state in shapes that don't always match the definition schemas
 * one-to-one — most notably:
 *
 *   - LoggerTableForm uses `user_columns` (only the user-defined columns,
 *     since the implicit columns event_id/event_timestamp/ds/hour are rendered
 *     for free) but the saved spec uses `columns`.
 *   - LattikTableForm stores `key_mapping` as an array of {pk_column,
 *     source_column} pairs but the spec uses a Record<string, string>.
 *   - All array entries carry a synthetic `_key` field for React keying that
 *     does not belong in the saved spec.
 *
 * The LLM should NEVER be asked to do this translation by hand — getting it
 * wrong (e.g. emitting `user_columns` instead of `columns`) is exactly how
 * static checks used to fail spuriously. Tools that need the spec call
 * `canvasStateToSpec(kind, canvasState)` instead of accepting a `specJson`
 * parameter from the model.
 */

/**
 * Extract the form state from a JSON-Render Spec object. Tools receive the
 * full Spec via `options.canvasState`; the editable form fields live under
 * `spec.state`.
 */
export function getCanvasFormState(canvasState: unknown): Record<string, unknown> {
  if (!canvasState || typeof canvasState !== "object") return {};
  const maybeState = (canvasState as { state?: unknown }).state;
  if (!maybeState || typeof maybeState !== "object") return {};
  return maybeState as Record<string, unknown>;
}

/**
 * Read the definition's `name` field directly from canvas state. Every form
 * exposes its name at `/name`. Returns null when missing or empty so callers
 * can return a structured error instead of silently using "".
 */
export function getDefinitionNameFromCanvas(canvasState: unknown): string | null {
  const name = getCanvasFormState(canvasState).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Return a cleaned-up copy of the canvas form state suitable for showing to a
 * downstream LLM (the reviewer). Strips React-only `_key` fields recursively
 * and deduplicates array entries by `name` so spec-stream loops (e.g. Haiku
 * occasionally emitting hundreds of duplicate columns) don't poison the
 * reviewer's context. The shape is preserved exactly otherwise — paths the
 * reviewer returns are still valid against the live canvas state.
 */
export function sanitizeCanvasFormState(
  canvasState: unknown
): Record<string, unknown> {
  const state = getCanvasFormState(canvasState);
  return cleanValue(state) as Record<string, unknown>;
}

function cleanValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of v) {
      const cleaned = cleanValue(item);
      // Deduplicate object entries by `name` (the canonical identity field on
      // every list item shape — columns, primary keys, calculations, etc.).
      if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
        const name = (cleaned as { name?: unknown }).name;
        if (typeof name === "string" && name.length > 0) {
          if (seen.has(name)) continue;
          seen.add(name);
        }
      }
      out.push(cleaned);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "_key") continue;
      out[k] = cleanValue(val);
    }
    return out;
  }
  return v;
}

// ---- Helpers ----

function asObjectArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

// ---- Per-kind converters ----

function entityFromCanvas(s: Record<string, unknown>): unknown {
  return {
    name: s.name,
    description: s.description,
    id_field: s.id_field,
    id_type: s.id_type,
  };
}

function dimensionFromCanvas(s: Record<string, unknown>): unknown {
  return {
    name: s.name,
    description: s.description,
    entity: s.entity,
    source_table: s.source_table,
    source_column: s.source_column,
    data_type: s.data_type,
  };
}

function loggerTableFromCanvas(s: Record<string, unknown>): unknown {
  // user_columns → columns. The implicit columns (event_id, event_timestamp,
  // ds, hour) are not part of the saved spec — they're rendered by the form
  // for display only.
  const columns = asObjectArray(s.user_columns).map((col) => {
    const out: Record<string, unknown> = {
      name: col.name,
      type: col.type,
    };
    if (col.dimension !== undefined) out.dimension = col.dimension;
    if (col.description !== undefined) out.description = col.description;

    // The form's `pii` toggle maps to a `pii` entry in the saved spec's tags.
    const tags: string[] = Array.isArray(col.tags) ? (col.tags as string[]).slice() : [];
    if (col.pii === true && !tags.includes("pii")) tags.push("pii");
    if (tags.length > 0) out.tags = tags;

    return out;
  });

  return {
    name: s.name,
    description: s.description,
    retention: s.retention,
    dedup_window: s.dedup_window,
    columns,
  };
}

function lattikTableFromCanvas(s: Record<string, unknown>): unknown {
  const primary_key = asObjectArray(s.primary_key).map((pk) => omit(pk, ["_key"]));

  const column_families = asObjectArray(s.column_families).map((cf) => {
    // key_mapping: array of {pk_column, source_column} → Record<pk_column, source_column>
    const key_mapping: Record<string, string> = {};
    for (const pair of asObjectArray(cf.key_mapping)) {
      const pkCol = pair.pk_column;
      const srcCol = pair.source_column;
      if (typeof pkCol === "string" && pkCol.length > 0 && typeof srcCol === "string") {
        key_mapping[pkCol] = srcCol;
      }
    }

    return {
      name: cf.name,
      source: cf.source,
      key_mapping,
      columns: asObjectArray(cf.columns).map((col) => omit(col, ["_key"])),
    };
  });

  const derived_columns = asObjectArray(s.derived_columns).map((dc) => omit(dc, ["_key"]));

  const out: Record<string, unknown> = {
    name: s.name,
    description: s.description,
    primary_key,
    column_families,
  };
  if (derived_columns.length > 0) out.derived_columns = derived_columns;
  return out;
}

function metricFromCanvas(s: Record<string, unknown>): unknown {
  return {
    name: s.name,
    description: s.description,
    calculations: asObjectArray(s.calculations).map((c) => omit(c, ["_key"])),
  };
}

/**
 * Convert canvas form state to a definition spec for validation/storage.
 *
 * Goes through `sanitizeCanvasFormState` first so validators see the same
 * deduplicated, _key-stripped view that the display layer renders. Without
 * this, occasional Haiku stream-loop bugs (where the agent emits hundreds
 * of duplicate column entries in a single `add /state/user_columns` patch)
 * cause spurious "duplicate column name" errors during static checks even
 * though the rendered canvas only shows one column.
 */
export function canvasStateToSpec(
  kind: DefinitionKind,
  canvasState: unknown
): unknown {
  const state = sanitizeCanvasFormState(canvasState);
  switch (kind) {
    case "entity":
      return entityFromCanvas(state);
    case "dimension":
      return dimensionFromCanvas(state);
    case "logger_table":
      return loggerTableFromCanvas(state);
    case "lattik_table":
      return lattikTableFromCanvas(state);
    case "metric":
      return metricFromCanvas(state);
  }
}
