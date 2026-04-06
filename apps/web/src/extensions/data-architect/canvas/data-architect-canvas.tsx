"use client";

import { useRef } from "react";
import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { registry } from "./registry";

const EMPTY_STATE: Record<string, unknown> = {};

interface DataArchitectCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
}

export function DataArchitectCanvas({ spec, loading, onStateChange }: DataArchitectCanvasProps) {
  if (!spec) return null;

  // Stabilize initialState: keep the same reference when content hasn't changed,
  // preventing the StateProvider from re-syncing state on every parent render.
  const prevStateRef = useRef(spec.state ?? EMPTY_STATE);
  const prevStateJsonRef = useRef<string | null>(null);
  const stateObj = spec.state ?? EMPTY_STATE;
  const stateJson = JSON.stringify(stateObj);
  if (stateJson !== prevStateJsonRef.current) {
    prevStateJsonRef.current = stateJson;
    prevStateRef.current = stateObj;
  }

  return (
    <JSONUIProvider
      registry={registry}
      initialState={prevStateRef.current}
      onStateChange={onStateChange}
    >
      <div className="relative flex flex-1 flex-col gap-4 p-5">
        <Renderer spec={spec} registry={registry} loading={loading} />
      </div>
    </JSONUIProvider>
  );
}
