import type { Spec } from "@json-render/core";
import type { QueryResultIntent } from "@eloquio/render-intents";

/**
 * Project a QueryResultIntent into the json-render Spec apps/web's
 * canvas registry already understands. The `QueryResultTable`
 * component renders columns as headers and rows as a table; the
 * truncated flag drives the "showing first N of M" footer.
 */
export function queryResultToSpec(intent: QueryResultIntent): Spec {
  const { columns, rows, rowCount, truncated, durationMs } = intent.data;
  return {
    root: "main",
    elements: {
      main: {
        type: "QueryResultTable",
        props: {
          columns,
          rows,
          rowCount,
          truncated,
          durationMs,
        },
        children: [],
      },
    },
    state: {},
  } as Spec;
}
