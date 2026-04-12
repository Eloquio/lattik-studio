import type { ComponentType } from "react";
import type { Spec } from "@json-render/core";
import { DataArchitectCanvas } from "./data-architect/canvas/data-architect-canvas";
import { DataAnalystCanvas } from "./data-analyst/canvas/data-analyst-canvas";
import { PipelineManagerCanvas } from "./pipeline-manager/canvas/pipeline-manager-canvas";

type CanvasComponent = ComponentType<{
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  onSendMessage?: (text: string) => void;
}>;

const canvases: Record<string, CanvasComponent> = {
  "data-architect": DataArchitectCanvas,
  "data-analyst": DataAnalystCanvas,
  "pipeline-manager": PipelineManagerCanvas,
};

export function getCanvas(id: string): CanvasComponent | undefined {
  return canvases[id];
}
