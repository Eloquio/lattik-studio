"use client";

import { useState } from "react";
import { NavPanel } from "@/components/layout/nav-panel";
import { ChatPanel } from "@/components/chat/chat-panel";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { useCanvas } from "@/hooks/use-canvas";

export default function Home() {
  const canvas = useCanvas();
  const [activeExtensionId, setActiveExtensionId] = useState<string | null>(null);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      {/* Background image + blur */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      {/* Content */}
      <NavPanel />

      <div className="relative z-10 flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatPanel
            activeExtensionId={activeExtensionId}
            onCanvasStateChange={canvas.setCanvasState}
            onExtensionChange={setActiveExtensionId}
          />
        </div>

        {/* Canvas toggle button (visible when canvas is closed) */}
        {!canvas.isOpen && (
          <button
            onClick={canvas.open}
            className="absolute right-0 top-1/2 -translate-y-1/2 flex h-12 w-4 items-center justify-center rounded-l-md border border-r-0 border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Open canvas"
          >
            <div className="h-6 w-0.5 rounded-full bg-current opacity-50" />
          </button>
        )}

        {/* Canvas panel */}
        <CanvasPanel
          isOpen={canvas.isOpen}
          width={canvas.width}
          onWidthChange={canvas.setWidth}
          onClose={canvas.close}
          activeExtensionId={activeExtensionId}
          canvasState={canvas.canvasState}
        />
      </div>
    </div>
  );
}
