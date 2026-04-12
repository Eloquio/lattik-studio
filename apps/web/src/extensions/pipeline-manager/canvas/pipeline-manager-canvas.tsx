"use client";

import { useRef } from "react";
import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { registry } from "./registry";

const EMPTY_STATE: Record<string, unknown> = {};

interface PipelineManagerCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  onSendMessage?: (text: string) => void;
}

export function PipelineManagerCanvas({
  spec,
  loading,
  onStateChange,
}: PipelineManagerCanvasProps) {
  const prevStateRef = useRef(EMPTY_STATE as Record<string, unknown>);
  const prevStateJsonRef = useRef<string | null>(null);

  if (!spec) return null;

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
