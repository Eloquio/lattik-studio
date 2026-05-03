/**
 * @eloquio/json-render-adapter — translates RenderIntent → json-render Spec.
 *
 * The web client receives intents as tool results in the chat stream.
 * This adapter pattern-matches on the intent's `kind` discriminator and
 * dispatches to a per-kind translator function. The output is a
 * json-render Spec the existing canvas registry already understands.
 *
 * Adding a new intent kind: write a per-kind module (e.g. `dag-overview.ts`),
 * import the translator here, and add a case to `intentToSpec`. The
 * compiler enforces exhaustiveness via the `assertNever` fallthrough.
 */

import type { Spec } from "@json-render/core";
import type { RenderIntent } from "@eloquio/render-intents";
import { dagOverviewToSpec } from "./dag-overview.js";
import { dagRunDetailToSpec } from "./dag-run-detail.js";

export { dagOverviewToSpec } from "./dag-overview.js";
export { dagRunDetailToSpec } from "./dag-run-detail.js";

/**
 * Per-kind dispatcher. The adapter is currently complete only for
 * `dag-overview`; intents whose kinds aren't yet implemented return a
 * placeholder error spec the canvas registry can render as a "this
 * surface isn't wired up yet" message rather than crashing.
 */
export function intentToSpec(intent: RenderIntent): Spec {
  switch (intent.kind) {
    case "dag-overview":
      return dagOverviewToSpec(intent);

    case "dag-run-detail":
      return dagRunDetailToSpec(intent);

    case "entity-form":
    case "dimension-form":
    case "logger-table-form":
    case "lattik-table-form":
    case "metric-form":
    case "definition-review":
    case "yaml-preview":
    case "pr-submitted":
    case "sql-editor":
    case "query-result":
    case "chart":
      return placeholderSpec(intent.kind);

    default:
      return assertNever(intent);
  }
}

function placeholderSpec(kind: string): Spec {
  return {
    root: "main",
    elements: {
      main: {
        type: "PlaceholderCard",
        props: {
          title: "Render adapter pending",
          message: `The "${kind}" intent doesn't have a json-render adapter yet — implement it in @eloquio/json-render-adapter.`,
        },
      },
    },
    state: {},
  } as Spec;
}

function assertNever(value: never): never {
  throw new Error(
    `json-render-adapter: unexpected intent ${JSON.stringify(value)}`,
  );
}
