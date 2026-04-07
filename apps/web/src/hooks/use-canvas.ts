"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { Spec } from "@json-render/core";
import { getByPath } from "@json-render/core";
import { immutableSetByPath } from "@json-render/core/store-utils";

export function useCanvas() {
  const [isOpen, setIsOpen] = useState(false);
  const [width, setWidth] = useState(50);
  const [canvasSpec, _setCanvasSpec] = useState<Spec | null>(null);

  // Tracks state paths the user has locally edited (form input or accepted
  // suggestion patches) that the streaming agent does not yet know about.
  // When a fresh spec arrives from the AI stream, these paths are restored
  // from the previous canvas state so local edits aren't clobbered. The set
  // is cleared when the canvas spec is fully replaced or when the agent
  // emits a structural change (i.e. renders a different form).
  const locallyEditedPathsRef = useRef<Set<string>>(new Set());

  // Hydrate layout prefs from localStorage after mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("canvas-layout");
      if (stored) {
        const { isOpen: savedOpen, width: savedWidth } = JSON.parse(stored);
        if (typeof savedOpen === "boolean") setIsOpen(savedOpen);
        if (typeof savedWidth === "number") setWidth(savedWidth);
      }
    } catch {}
  }, []);

  // Persist layout prefs to localStorage
  useEffect(() => {
    localStorage.setItem("canvas-layout", JSON.stringify({ isOpen, width }));
  }, [isOpen, width]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev: boolean) => !prev), []);

  // Hard reset of the canvas spec — used for new chats and conversation
  // restores from the database. Always clears local edit tracking because
  // the new spec is the canonical truth, not an incremental update.
  const setCanvasSpec = useCallback((spec: Spec | null) => {
    locallyEditedPathsRef.current.clear();
    _setCanvasSpec(spec);
  }, []);

  // Merge state changes from canvas interactions into the spec. Tracks each
  // touched path in `locallyEditedPathsRef` so a subsequent stream rebuild
  // (which knows nothing about these local merges) can restore them instead
  // of clobbering them.
  //
  // Uses `immutableSetByPath` so nested writes like `/user_columns/0/description`
  // produce fresh array/object references at every ancestor level — required
  // because the StateProvider in @json-render/react diffs flat snapshots by
  // identity per top-level key, and `flattenToPointers` treats arrays as
  // leaves. Mutating an array in place would silently miss the diff.
  const mergeStateChanges = useCallback(
    (changes: Array<{ path: string; value: unknown }>) => {
      _setCanvasSpec((prev) => {
        if (!prev) return prev;
        let nextState: Record<string, unknown> | null = null;
        for (const { path, value } of changes) {
          const target = nextState ?? prev.state ?? {};
          if (getByPath(target, path) === value) continue;
          nextState = immutableSetByPath(target, path, value);
          locallyEditedPathsRef.current.add(path);
        }
        if (nextState === null) return prev;
        return { ...prev, state: nextState };
      });
    },
    []
  );

  // Apply a freshly-rebuilt spec from the AI stream while preserving any
  // state paths the user has locally edited since the previous stream
  // rebuild. This is the coordination point between the two writers:
  //
  //   - Stream writer (chat-panel.tsx): rebuilds the spec from cumulative
  //     `data-spec` parts on every messages update and calls applyStreamSpec.
  //   - Local merge writer (form input + suggestion accepts): patches the
  //     spec via mergeStateChanges and records each path it touches.
  //
  // Without this coordination the stream writer's rebuild would clobber
  // local merges every time the agent streams a new chunk — that's how
  // accepted suggestion descriptions kept "disappearing" from the canvas.
  //
  // Structural change detection: when the agent renders a different form
  // (root or elements differ), the previous local edits no longer apply,
  // so we clear the tracking set and replace the spec wholesale.
  const applyStreamSpec = useCallback((spec: unknown) => {
    _setCanvasSpec((prev) => {
      if (spec === null || spec === undefined) {
        locallyEditedPathsRef.current.clear();
        return null;
      }
      const next = spec as Spec;

      // First spec ever, or first spec after a reset — adopt as-is.
      if (!prev) {
        locallyEditedPathsRef.current.clear();
        return next;
      }

      // Detect a structural change: the agent rendered a different form,
      // so the old local edits are stale and should be discarded.
      const structureChanged =
        prev.root !== next.root ||
        JSON.stringify(prev.elements) !== JSON.stringify(next.elements);
      if (structureChanged) {
        locallyEditedPathsRef.current.clear();
        return next;
      }

      // Same structure as before — preserve every state path the user has
      // locally edited since the last stream rebuild by restoring it from
      // the previous canvas state into the new stream-rebuilt state.
      const editedPaths = locallyEditedPathsRef.current;
      if (editedPaths.size === 0) {
        return next;
      }

      const prevState = (prev.state ?? {}) as Record<string, unknown>;
      let mergedState = (next.state ?? {}) as Record<string, unknown>;
      for (const path of editedPaths) {
        const localValue = getByPath(prevState, path);
        const streamValue = getByPath(mergedState, path);
        if (localValue !== streamValue) {
          mergedState = immutableSetByPath(mergedState, path, localValue);
        }
      }

      return { ...next, state: mergedState };
    });
  }, []);

  return {
    isOpen,
    width,
    setWidth,
    open,
    close,
    toggle,
    canvasSpec,
    setCanvasSpec,
    applyStreamSpec,
    mergeStateChanges,
  };
}
