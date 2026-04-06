"use client";

import { useMemo, useRef } from "react";
import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { CanvasActionsContext } from "@/components/canvas/canvas-actions-context";
import { registry } from "./registry";

const EMPTY_STATE: Record<string, unknown> = {};

interface DataArchitectCanvasProps {
  spec: Spec | null;
  loading?: boolean;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  onSendMessage?: (text: string) => void;
}

export function DataArchitectCanvas({ spec, loading, onStateChange, onSendMessage }: DataArchitectCanvasProps) {
  // All hooks must be called unconditionally (before any early return)
  // to satisfy React's rules of hooks.
  const prevStateRef = useRef(EMPTY_STATE as Record<string, unknown>);
  const prevStateJsonRef = useRef<string | null>(null);

  const sendRef = useRef(onSendMessage);
  sendRef.current = onSendMessage;
  const actions = useMemo(() => ({
    sendChatMessage: (text: string) => sendRef.current?.(text),
  }), []);

  if (!spec) return null;

  // Stabilize initialState: keep the same reference when content hasn't changed,
  // preventing the StateProvider from re-syncing state on every parent render.
  const stateObj = spec.state ?? EMPTY_STATE;
  const stateJson = JSON.stringify(stateObj);
  if (stateJson !== prevStateJsonRef.current) {
    prevStateJsonRef.current = stateJson;
    prevStateRef.current = stateObj;
  }

  return (
    <CanvasActionsContext value={actions}>
      <JSONUIProvider
        registry={registry}
        initialState={prevStateRef.current}
        onStateChange={onStateChange}
      >
        <div className="relative flex flex-1 flex-col gap-4 p-5">
          <Renderer spec={spec} registry={registry} loading={loading} />
        </div>
      </JSONUIProvider>
    </CanvasActionsContext>
  );
}
