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
  // Latest-ref mirror so the stable `actions` memo always calls the freshest
  // onSendMessage from its deferred callback, without re-creating `actions`.
  sendRef.current = onSendMessage;
  const actions = useMemo(() => ({
    sendChatMessage: (text: string) => sendRef.current?.(text),
  }), []);

  // Memoize sanitize + stringify on the spec.state reference. The parent
  // (chat-panel) re-renders on every token; without this guard the entire
  // form state stringified on every keystroke during streaming. Pre-empts
  // both the sanitize walk and the JSON.stringify, which together scale
  // linearly with column count and dominate render time on wide tables.
  // The narrow [spec?.state] dep is the whole point — re-sanitize+stringify
  // only when that reference changes, not on every streaming-token re-render.
  // Disabling the memoization analysis here also quiets the React Compiler
  // `refs` check on this deliberate ref-based cache (shared pass; compiler off).
  /* eslint-disable react-hooks/exhaustive-deps */
  const stableState = useMemo(() => {
    if (!spec) return null;
    const sanitized = sanitizeState(spec.state ?? EMPTY_STATE);
    const json = JSON.stringify(sanitized);
    if (json !== prevStateJsonRef.current) {
      prevStateJsonRef.current = json;
      prevStateRef.current = sanitized;
    }
    return prevStateRef.current;
  }, [spec?.state]);
  /* eslint-enable react-hooks/exhaustive-deps */

  if (!spec || !stableState) return null;

  return (
    <EntityRegistryProvider>
      <CanvasActionsContext value={actions}>
        <JSONUIProvider
          registry={registry}
          initialState={stableState}
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
