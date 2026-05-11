import { createReadCanvasStateTool as createBase } from "../../tools/read-canvas-state";

export function createReadCanvasStateTool(getCanvasState: () => unknown) {
  return createBase({
    description:
      "Read the current canvas state. Returns the state object with any user selections (e.g. selectedDagId, selectedTaskId).",
    getCanvasState,
    project: (rawSpec) => {
      const baseSpec =
        rawSpec && typeof rawSpec === "object"
          ? (rawSpec as Record<string, unknown>)
          : {};
      return { canvasState: baseSpec };
    },
  });
}
