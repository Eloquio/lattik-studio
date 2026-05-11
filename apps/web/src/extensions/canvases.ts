import type { ComponentType } from "react";
import type { Spec } from "@json-render/core";
import { DataArchitectCanvas } from "./data-architect/canvas/data-architect-canvas";
import { DataAnalystCanvas } from "./data-analyst/canvas/data-analyst-canvas";
import { PipelineManagerCanvas } from "./pipeline-manager/canvas/pipeline-manager-canvas";

type CanvasComponent = ComponentType<{
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  /**
   * Optional handler the canvas component can call to send a follow-up
   * message into the chat on the user's behalf (e.g. a "submit" button on
   * a confirmation panel). Currently only data-architect's canvas uses it;
   * other extensions accept the prop but don't.
   */
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
