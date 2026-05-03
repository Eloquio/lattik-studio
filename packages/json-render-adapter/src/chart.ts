import type { Spec } from "@json-render/core";
import type { ChartIntent } from "@eloquio/render-intents";

/**
 * Project a ChartIntent into the json-render Spec apps/web's canvas
 * registry already understands. The intent carries chart configuration
 * (type + axes); the rendering component is responsible for pulling
 * the data from the most recent QueryResult on the same canvas (this
 * is a multi-surface concern — the chart surface and results surface
 * coexist on the canvas).
 */
export function chartToSpec(intent: ChartIntent): Spec {
  const { chartType, xColumn, yColumns, title } = intent.data;
  return {
    root: "main",
    elements: {
      main: {
        type: "ChartCard",
        props: {
          chartType,
          xColumn,
          yColumns,
          ...(title ? { title } : {}),
        },
        children: [],
      },
    },
    state: {},
  } as Spec;
}
