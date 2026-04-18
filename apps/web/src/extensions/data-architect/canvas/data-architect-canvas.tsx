"use client";

import { useMemo, useRef } from "react";
import type { Spec } from "@json-render/core";
import { Renderer, JSONUIProvider } from "@json-render/react";
import { CanvasActionsContext } from "@/components/canvas/canvas-actions-context";
import { EntityRegistryProvider } from "./entity-registry-context";
import { registry } from "./registry";
import { dedupeArray } from "../canvas-to-spec";

const EMPTY_STATE: Record<string, unknown> = {};

/**
 * Walk every array in the form state and run it through the shared
 * `dedupeArray` (which uses the `dedupKey` identity rule). Doing this for the
 * entire state — not just `user_columns` — keeps the rendered canvas in sync
 * with what `sanitizeCanvasFormState` shows the agent. Previously the canvas
 * deduped only `user_columns` while the tool sanitizer deduped everything by
 * `name`, which let the agent see "duplicates" the user couldn't see and
 * triggered review-loop bugs.
 */
function sanitizeState(state: Record<string, unknown>): Record<string, unknown> {
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) {
      const deduped = dedupeArray(value);
      if (deduped.length !== value.length) {
        mutated = true;
        out[key] = deduped;
        continue;
      }
    }
    out[key] = value;
  }
  return mutated ? out : state;
}

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
  // Also deduplicate user_columns by _key to guard against the agent streaming
  // spec patches that repeatedly append the same column entries.
  const stateObj = sanitizeState(spec.state ?? EMPTY_STATE);
  const stateJson = JSON.stringify(stateObj);
  if (stateJson !== prevStateJsonRef.current) {
    prevStateJsonRef.current = stateJson;
    prevStateRef.current = stateObj;
  }

  return (
    <EntityRegistryProvider>
      <CanvasActionsContext value={actions}>
        <JSONUIProvider
          registry={registry}
          initialState={prevStateRef.current}
          onStateChange={onStateChange}
        >
          <div className="relative flex min-h-0 flex-1 flex-col gap-4 p-5">
            <Renderer spec={spec} registry={registry} loading={loading} />
          </div>
        </JSONUIProvider>
      </CanvasActionsContext>
    </EntityRegistryProvider>
  );
}
