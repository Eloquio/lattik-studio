"use client";

import { useMemo, useRef } from "react";
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

  // Memoize the stringify guard on spec.state so token-by-token parent
  // re-renders during streaming don't pay the full-state stringify cost.
  // The narrow [spec?.state] dep is the whole point — re-stringify only when
  // that reference changes, not on every streaming-token re-render. Disabling
  // the memoization analysis here also quiets the React Compiler `refs` check
  // on this deliberate ref-based cache (shared analysis pass; compiler is off).
  /* eslint-disable react-hooks/exhaustive-deps */
  const stableState = useMemo(() => {
    if (!spec) return null;
    const stateObj = spec.state ?? EMPTY_STATE;
    const stateJson = JSON.stringify(stateObj);
    if (stateJson !== prevStateJsonRef.current) {
      prevStateJsonRef.current = stateJson;
      prevStateRef.current = stateObj;
    }
    return prevStateRef.current;
  }, [spec?.state]);
  /* eslint-enable react-hooks/exhaustive-deps */

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
