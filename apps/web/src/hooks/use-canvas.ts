"use client";

import { useState, useCallback, useEffect } from "react";

function loadState() {
  if (typeof window === "undefined") return { isOpen: false, width: 50 };
  try {
    const stored = localStorage.getItem("canvas-state");
    if (stored) return JSON.parse(stored);
  } catch {}
  return { isOpen: false, width: 50 };
}

export function useCanvas() {
  const [isOpen, setIsOpen] = useState(() => loadState().isOpen);
  const [width, setWidth] = useState(() => loadState().width);
  const [canvasState, setCanvasState] = useState<unknown>(null);

  useEffect(() => {
    localStorage.setItem("canvas-state", JSON.stringify({ isOpen, width }));
  }, [isOpen, width]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev: boolean) => !prev), []);

  return { isOpen, width, setWidth, open, close, toggle, canvasState, setCanvasState };
}
