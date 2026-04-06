"use client";

import { useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCanvas } from "@/extensions/canvases";
import type { Spec } from "@json-render/core";

interface CanvasPanelProps {
  isOpen: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  activeExtensionId: string | null;
  spec: Spec | null;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  onSendMessage?: (text: string) => void;
}

export function CanvasPanel({
  isOpen,
  width,
  onWidthChange,
  onClose,
  activeExtensionId,
  spec,
  onStateChange,
  onSendMessage,
}: CanvasPanelProps) {
  const isDragging = useRef(false);
  const handlersRef = useRef<{
    move: ((e: MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Clean up listeners on unmount
  useEffect(() => {
    return () => {
      if (handlersRef.current.move) {
        document.removeEventListener("mousemove", handlersRef.current.move);
      }
      if (handlersRef.current.up) {
        document.removeEventListener("mouseup", handlersRef.current.up);
      }
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return;
        const windowWidth = window.innerWidth;
        const navWidth = 56;
        const availableWidth = windowWidth - navWidth;
        const newWidth =
          ((windowWidth - e.clientX) / availableWidth) * 100;
        onWidthChange(Math.min(Math.max(newWidth, 20), 80));
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        handlersRef.current = { move: null, up: null };
      };

      // Clean up any stale listeners
      if (handlersRef.current.move) {
        document.removeEventListener("mousemove", handlersRef.current.move);
      }
      if (handlersRef.current.up) {
        document.removeEventListener("mouseup", handlersRef.current.up);
      }

      handlersRef.current = { move: handleMouseMove, up: handleMouseUp };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [onWidthChange]
  );

  if (!isOpen) return null;

  return (
    <div
      className="relative flex h-full shrink-0"
      style={{ width: `${width}%` }}
    >
      {/* Resize handle (overlaid on left edge) */}
      <div
        className="absolute left-0 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-center"
        onMouseDown={handleMouseDown}
      >
        <div className="h-8 w-0.5 rounded-full bg-white/20" />
      </div>

      {/* Canvas content */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-l-xl bg-stone-50 shadow-lg">
        <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-2 rounded-tl-xl">
          <span className="text-sm font-medium text-stone-700">Canvas</span>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-stone-500 hover:bg-stone-100 hover:text-stone-700" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto rounded-bl-xl">
          {activeExtensionId && (() => {
            const Canvas = getCanvas(activeExtensionId);
            if (!Canvas) return null;
            return <Canvas spec={spec} onStateChange={onStateChange} onSendMessage={onSendMessage} />;
          })()}
        </div>
      </div>
    </div>
  );
}
