import type { Spec } from "@json-render/core";
import type {
  EntityFormIntent,
  DimensionFormIntent,
  LoggerTableFormIntent,
  LattikTableFormIntent,
  MetricFormIntent,
} from "@eloquio/render-intents";
import {
  buildEntityFormSpec,
  buildDimensionFormSpec,
  buildLoggerTableFormSpec,
  buildLattikTableFormSpec,
  buildMetricFormSpec,
  entityFormInitialStateSchema,
  dimensionFormInitialStateSchema,
  loggerTableFormInitialStateSchema,
  lattikTableFormInitialStateSchema,
  metricFormInitialStateSchema,
} from "./form-builders.js";

/**
 * Per-kind form-intent translators. Each parses the intent's
 * `data.initialState` against the form's typed schema (so the agent
 * can pass loose `Record<string, unknown>` through the wire and the
 * adapter validates at the trust boundary), then composes the
 * canonical Spec via the matching build*FormSpec helper.
 *
 * If validation fails — meaning the LLM tool-called with a shape the
 * form schema doesn't accept — the adapter falls back to the default
 * empty form rather than crashing the canvas. This matches the
 * apps/web pattern where defense-in-depth treats the LLM as
 * potentially-broken.
 */

function safeFormSpec<S extends import("zod").ZodTypeAny>(
  schema: S,
  initialState: unknown,
  builder: (s: import("zod").infer<S>) => Spec,
): Spec {
  const parsed = schema.safeParse(initialState ?? {});
  // Validation failure → fall back to a default empty form. Each form's
  // initial-state schema permits all-empty input (every field optional),
  // so schema.parse({}) returns the typed default shape rather than
  // throwing.
  return builder(parsed.success ? parsed.data : schema.parse({}));
}

export function entityFormToSpec(intent: EntityFormIntent): Spec {
  return safeFormSpec(
    entityFormInitialStateSchema,
    intent.data.initialState,
    buildEntityFormSpec,
  );
}

export function dimensionFormToSpec(intent: DimensionFormIntent): Spec {
  return safeFormSpec(
    dimensionFormInitialStateSchema,
    intent.data.initialState,
    buildDimensionFormSpec,
  );
}

export function loggerTableFormToSpec(intent: LoggerTableFormIntent): Spec {
  return safeFormSpec(
    loggerTableFormInitialStateSchema,
    intent.data.initialState,
    buildLoggerTableFormSpec,
  );
}

export function lattikTableFormToSpec(intent: LattikTableFormIntent): Spec {
  return safeFormSpec(
    lattikTableFormInitialStateSchema,
    intent.data.initialState,
    buildLattikTableFormSpec,
  );
}

export function metricFormToSpec(intent: MetricFormIntent): Spec {
  return safeFormSpec(
    metricFormInitialStateSchema,
    intent.data.initialState,
    buildMetricFormSpec,
  );
}
