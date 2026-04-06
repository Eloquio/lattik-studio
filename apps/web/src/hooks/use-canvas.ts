"use client";

import { useState, useCallback, useEffect } from "react";
import type { Spec } from "@json-render/core";
import { getByPath, setByPath } from "@json-render/core";

export function useCanvas() {
  const [isOpen, setIsOpen] = useState(false);
  const [width, setWidth] = useState(50);
  const [canvasSpec, setCanvasSpec] = useState<Spec | null>(null);

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

  // Merge state changes from canvas interactions into the spec.
  // Bail out (return prev) when no values actually changed to avoid
  // cascading re-renders that can trigger infinite update depth.
  const mergeStateChanges = useCallback(
    (changes: Array<{ path: string; value: unknown }>) => {
      setCanvasSpec((prev) => {
        if (!prev) return prev;
        const prevState = prev.state ?? {};
        let changed = false;
        for (const { path, value } of changes) {
          if (getByPath(prevState, path) !== value) {
            changed = true;
            break;
          }
        }
        if (!changed) return prev;
        const nextState = { ...prevState };
        for (const { path, value } of changes) {
          setByPath(nextState, path, value);
        }
        return { ...prev, state: nextState };
      });
    },
    []
  );

  return {
    isOpen,
    width,
    setWidth,
    open,
    close,
    toggle,
    canvasSpec,
    setCanvasSpec,
    mergeStateChanges,
  };
}
