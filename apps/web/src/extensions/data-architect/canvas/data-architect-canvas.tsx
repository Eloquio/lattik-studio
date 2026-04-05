"use client";

import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { registry } from "./registry";

const EMPTY_SPEC: Spec = {
  root: "empty",
  elements: {
    empty: { type: "EmptyState", props: {} },
  },
};

interface DataArchitectCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
}

export function DataArchitectCanvas({ spec, loading, onStateChange }: DataArchitectCanvasProps) {
  const activeSpec = spec ?? EMPTY_SPEC;

  return (
    <JSONUIProvider
      registry={registry}
      initialState={activeSpec.state ?? {}}
      onStateChange={onStateChange}
    >
      <div className="relative flex flex-1 flex-col gap-4 p-5">
        <Renderer spec={activeSpec} registry={registry} loading={loading} />
      </div>
    </JSONUIProvider>
  );
}
