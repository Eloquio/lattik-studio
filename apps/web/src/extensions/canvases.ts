import type { ComponentType } from "react";
import dynamic from "next/dynamic";
import type { Spec } from "@json-render/core";

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

// Each canvas registry transitively pulls in heavy editor/chart deps —
// @uiw/react-codemirror + @codemirror/lang-{yaml,sql} + recharts + the
// 2000+-line Data Architect registry — and only one extension's canvas can
// be on screen at a time. Splitting them into separate chunks shaves
// hundreds of KB off the initial JS payload for the first paint. SSR is
// off because the canvases are entirely client-side (CodeMirror et al.
// need `document`).
const DataArchitectCanvas = dynamic(
  () =>
    import("./data-architect/canvas/data-architect-canvas").then((m) => ({
      default: m.DataArchitectCanvas,
    })),
  { ssr: false },
) as CanvasComponent;

const DataAnalystCanvas = dynamic(
  () =>
    import("./data-analyst/canvas/data-analyst-canvas").then((m) => ({
      default: m.DataAnalystCanvas,
    })),
  { ssr: false },
) as CanvasComponent;

const PipelineManagerCanvas = dynamic(
  () =>
    import("./pipeline-manager/canvas/pipeline-manager-canvas").then((m) => ({
      default: m.PipelineManagerCanvas,
    })),
  { ssr: false },
) as CanvasComponent;

const canvases: Record<string, CanvasComponent> = {
  "data-architect": DataArchitectCanvas,
  "data-analyst": DataAnalystCanvas,
  "pipeline-manager": PipelineManagerCanvas,
};

export function getCanvas(id: string): CanvasComponent | undefined {
  return canvases[id];
}
