"use client";

import { useMemo, useRef } from "react";
import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { registry } from "./registry";

const EMPTY_STATE: Record<string, unknown> = {};

interface DataAnalystCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  onSendMessage?: (text: string) => void;
}

export function DataAnalystCanvas({
  spec,
  loading,
  onStateChange,
}: DataAnalystCanvasProps) {
  const prevStateRef = useRef(EMPTY_STATE as Record<string, unknown>);
  const prevStateJsonRef = useRef<string | null>(null);

  // Stabilize initialState by memoizing the stringify guard on the spec's
  // state reference. Re-running this on every parent render (which fires per
  // token during streaming) was paying the JSON.stringify cost on query
  // result tables that can be megabytes.
  const stableState = useMemo(() => {
    if (!spec) return null;
    const stateObj = (spec.state ?? EMPTY_STATE) as Record<string, unknown>;
    const stateJson = JSON.stringify(stateObj);
    if (stateJson !== prevStateJsonRef.current) {
      prevStateJsonRef.current = stateJson;
      prevStateRef.current = stateObj;
    }
    return prevStateRef.current;
  }, [spec?.state]);

  if (!spec || !stableState) return null;

  return (
    <JSONUIProvider
      registry={registry}
      initialState={stableState}
      onStateChange={onStateChange}
    >
      <div className="relative flex flex-1 flex-col gap-4 p-5">
        <Renderer spec={spec} registry={registry} loading={loading} />
      </div>
    </JSONUIProvider>
  );
}
