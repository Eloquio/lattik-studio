"use client";

import { useState, useCallback, useEffect } from "react";

export function useCanvas() {
  const [isOpen, setIsOpen] = useState(false);
  const [width, setWidth] = useState(50);
  const [canvasState, setCanvasState] = useState<unknown>(null);

  // Hydrate from localStorage after mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("canvas-state");
      if (stored) {
        const { isOpen: savedOpen, width: savedWidth } = JSON.parse(stored);
        if (typeof savedOpen === "boolean") setIsOpen(savedOpen);
        if (typeof savedWidth === "number") setWidth(savedWidth);
      }
    } catch {}
  }, []);

  // Persist to localStorage on change
  useEffect(() => {
    localStorage.setItem("canvas-state", JSON.stringify({ isOpen, width }));
  }, [isOpen, width]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev: boolean) => !prev), []);

  return { isOpen, width, setWidth, open, close, toggle, canvasState, setCanvasState };
}
