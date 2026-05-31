/**
 * Pure helpers for the Workflows run-card accordion's `?open=` URL state.
 *
 * Extracted from `workflows-view.tsx` so the URL clamp and accordion toggle
 * rules can be unit-tested without rendering the client component. Kept free of
 * React / Next imports for that reason — do not add any here.
 *
 * Contract: the panel is an accordion, so at most one run card is open at a
 * time. State is still modeled as a `Set<string>` (so the existing
 * `openRunIds.has(id)` consumers stay unchanged), but these helpers guarantee
 * the set never holds more than one id.
 */

/**
 * Read the initial open-card set from a `?open=` param value.
 *
 * Tolerates older multi-id share links (`?open=a,b`) by keeping only the first
 * id — accordion state holds at most one. Missing / empty / all-empty values
 * yield an empty set.
 */
export function parseOpenParam(raw: string | null): Set<string> {
  const [first] = (raw ?? "").split(",").filter(Boolean);
  return new Set(first ? [first] : []);
}

/**
 * Accordion toggle: clicking the already-open card closes it; clicking any
 * other card opens it and collapses whatever was open before.
 */
export function toggleOpenRun(prev: Set<string>, runId: string): Set<string> {
  return prev.has(runId) ? new Set<string>() : new Set([runId]);
}

/**
 * Serialize the open-card set back to a `?open=` param value, or `null` when
 * nothing is open (so the caller drops the param entirely).
 */
export function serializeOpenParam(ids: Set<string>): string | null {
  return ids.size > 0 ? Array.from(ids).join(",") : null;
}
