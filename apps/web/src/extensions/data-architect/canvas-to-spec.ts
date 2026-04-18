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
 * Pick the deduplication identity for an array entry. Prefer the synthetic
 * React `_key` (every form row sets one), and fall back to `name` for entries
 * the agent appended without going through the form. Returning `null` means
 * "no stable identity" — those entries are never deduplicated.
 *
 * Both the live canvas (`DataArchitectCanvas`) and the tool-read sanitizer
 * MUST use this function so that what the reviewer sees and what the user
 * sees agree. Mismatched identity rules previously caused spurious
 * "duplicate column" loops where the agent's view contained columns the
 * canvas had already merged away.
 */
export function dedupKey(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec._key === "string" && rec._key.length > 0) return `k:${rec._key}`;
  if (typeof rec.name === "string" && rec.name.length > 0) return `n:${rec.name}`;
  return null;
}

/**
 * Deduplicate an array of items by their `dedupKey` (preserves order, keeps
 * the first occurrence). Used by the canvas component to guard against the
 * agent streaming duplicate spec patches.
 */
export function dedupeArray<T>(arr: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const key = dedupKey(item);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}

/**
 * Return a cleaned-up copy of the canvas form state suitable for showing to a
 * downstream LLM (the reviewer). Strips React-only `_key` fields recursively
 * and deduplicates array entries (using `dedupKey` — the same identity rule
 * the canvas component uses) so spec-stream loops (e.g. Haiku occasionally
 * emitting hundreds of duplicate columns) don't poison the reviewer's
 * context. The shape is preserved exactly otherwise — paths the reviewer
 * returns are still valid against the live canvas state.
 */
export function sanitizeCanvasFormState(
  canvasState: unknown
): Record<string, unknown> {
  const state = getCanvasFormState(canvasState);
  return cleanValue(state) as Record<string, unknown>;
}

function cleanValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    // Dedupe BEFORE stripping `_key` so the synthetic React identity is
    // available for matching. After dedup, recurse into each surviving entry
    // to strip `_key` and clean nested arrays.
    return dedupeArray(v).map(cleanValue);
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

    // Classification flags (pii/phi/financial/credentials) are the canonical
    // compliance metadata — form state and spec share the same shape, so this
    // is a pass-through. Drop flags set to false/undefined so the saved spec
    // only carries the true ones.
    if (col.classification && typeof col.classification === "object" && !Array.isArray(col.classification)) {
      const cls = col.classification as Record<string, unknown>;
      const trimmed: Record<string, true> = {};
      for (const [k, v] of Object.entries(cls)) {
        if (v === true) trimmed[k] = true;
      }
      if (Object.keys(trimmed).length > 0) out.classification = trimmed;
    }

    // `tags` is reserved for non-compliance labels (e.g. "high-cardinality",
    // "deprecated"). Compliance tags like "pii" now live in `classification`.
    if (Array.isArray(col.tags) && col.tags.length > 0) out.tags = col.tags;

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

    const columns = asObjectArray(cf.columns).map((col) => {
      const base = omit(col, ["_key"]);
      // Strip fields that don't belong to the column's strategy
      const strategy = base.strategy as string | undefined;
      if (strategy === "lifetime_window") {
        return { name: base.name, strategy, agg: base.agg, ...(base.type ? { type: base.type } : {}), ...(base.description ? { description: base.description } : {}) };
      }
      if (strategy === "prepend_list") {
        return { name: base.name, strategy, expr: base.expr, max_length: base.max_length, ...(base.type ? { type: base.type } : {}), ...(base.description ? { description: base.description } : {}) };
      }
      if (strategy === "bitmap_activity") {
        return { name: base.name, strategy, granularity: base.granularity, window: base.window, ...(base.description ? { description: base.description } : {}) };
      }
      return base;
    });

    return {
      name: cf.name,
      source: cf.source,
      key_mapping,
      columns,
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

  // Backfill plan — canvas stores defaults inline so the form can render them,
  // but the saved spec should only carry fields the user customized. The
  // schema (`schema.ts`) declares defaults (lookback='30d', parallelism=1) and
  // applies them on read, so stripping defaults here keeps YAML minimal and
  // diffs readable.
  if (s.backfill && typeof s.backfill === "object" && !Array.isArray(s.backfill)) {
    const bf = s.backfill as Record<string, unknown>;
    const backfill: Record<string, unknown> = {};
    if (typeof bf.lookback === "string" && bf.lookback.length > 0 && bf.lookback !== "30d") {
      backfill.lookback = bf.lookback;
    }
    if (typeof bf.parallelism === "number" && bf.parallelism > 0 && bf.parallelism !== 1) {
      backfill.parallelism = bf.parallelism;
    }
    if (Object.keys(backfill).length > 0) out.backfill = backfill;
  }

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
