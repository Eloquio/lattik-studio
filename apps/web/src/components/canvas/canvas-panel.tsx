"use client";

import { useCallback, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataArchitectCanvas } from "@/extensions/data-architect/canvas/data-architect-canvas";

interface CanvasPanelProps {
  isOpen: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  activeExtensionId: string | null;
  canvasState: unknown;
}

export function CanvasPanel({
  isOpen,
  width,
  onWidthChange,
  onClose,
  activeExtensionId,
  canvasState,
}: CanvasPanelProps) {
  const isDragging = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return;
        const windowWidth = window.innerWidth;
        const navWidth = 56; // 14 * 4 = 56px (w-14)
        const availableWidth = windowWidth - navWidth;
        const newWidth =
          ((windowWidth - e.clientX) / availableWidth) * 100;
        onWidthChange(Math.min(Math.max(newWidth, 20), 80));
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

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
      <div className="flex flex-1 flex-col overflow-hidden rounded-l-xl bg-amber-50 shadow-lg">
        <div className="flex items-center justify-between border-b border-amber-200/60 bg-amber-100/50 px-4 py-2 rounded-tl-xl">
          <span className="text-sm font-medium text-amber-900">Canvas</span>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-amber-700 hover:bg-amber-200/50 hover:text-amber-900" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto rounded-bl-xl">
          {activeExtensionId === "data-architect" ? (
            <DataArchitectCanvas state={canvasState} />
          ) : (
            <div
              className="flex flex-1 flex-col p-4"
              style={{
                backgroundImage:
                  "linear-gradient(#e8d5b7 1px, transparent 1px), linear-gradient(90deg, #e8d5b7 1px, transparent 1px)",
                backgroundSize: "20px 20px",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
