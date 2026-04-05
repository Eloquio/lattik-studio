"use client";

import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { registry } from "./registry";
import { PipelineEmptyState } from "./pipeline-empty-state";

interface DataArchitectCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
}

export function DataArchitectCanvas({ spec, loading, onStateChange }: DataArchitectCanvasProps) {
  if (!spec) return <PipelineEmptyState />;

  return (
    <JSONUIProvider
      registry={registry}
      initialState={spec.state ?? {}}
      onStateChange={onStateChange}
    >
      <div className="flex flex-1 flex-col gap-4 p-5">
        <Renderer spec={spec} registry={registry} loading={loading} />
      </div>
    </JSONUIProvider>
  );
}
