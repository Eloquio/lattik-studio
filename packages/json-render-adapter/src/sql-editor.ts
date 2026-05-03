import type { Spec } from "@json-render/core";
import type { SqlEditorIntent } from "@eloquio/render-intents";

/**
 * Project a SqlEditorIntent into the json-render Spec apps/web's canvas
 * registry already understands. The `SqlEditor` component reads its
 * initial SQL from `state.sql`; user edits flow back through the canvas
 * state plumbing.
 */
export function sqlEditorToSpec(intent: SqlEditorIntent): Spec {
  return {
    root: "main",
    elements: {
      main: { type: "SqlEditor", props: {}, children: [] },
    },
    state: {
      sql: intent.data.sql,
    },
  } as Spec;
}
