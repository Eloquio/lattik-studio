"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { generateId } from "ai";
import type { Spec } from "@json-render/core";
import { NavPanel } from "@/components/layout/nav-panel";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ChatHistoryPanel } from "@/components/chat/chat-history-panel";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { useCanvas } from "@/hooks/use-canvas";
import { getConversation } from "@/lib/actions/conversations";
import type { TaskStackEntry } from "@/lib/types/task-stack";

const CHAT_ID_KEY = "lattik-active-chat";

interface ChatState {
  id: string;
  renderKey: number;
  initialMessages?: UIMessage[];
  savedTitle?: string;
}

export default function Home() {
  const canvas = useCanvas();
  const sendMessageRef = useRef<((text: string) => void) | null>(null);
  const [activeExtensionId, setActiveExtensionId] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<TaskStackEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [chat, setChat] = useState<ChatState>(() => ({
    id: (typeof window !== "undefined" && localStorage.getItem(CHAT_ID_KEY)) || generateId(),
    renderKey: 0,
  }));

  // Restore last conversation on mount.
  //
  // React 18 auto-batches setState calls inside the same task, so the four
  // updates below land in a single render. We still flush them in a fixed
  // order — extensionId BEFORE canvasSpec — so the canvas component, which
  // is keyed on extensionId, doesn't briefly mount with the wrong extension
  // pointing at the new spec. `flushSync` would force individual paints; we
  // explicitly want React's batching here.
  useEffect(() => {
    const savedId = localStorage.getItem(CHAT_ID_KEY);
    if (!savedId) return;
    let cancelled = false;
    getConversation(savedId)
      .then((conv) => {
        if (cancelled || !conv || !Array.isArray(conv.messages)) return;
        // Apply non-canvas state first so the canvas component sees a
        // consistent extension/task-stack pair when it (re)mounts.
        setActiveExtensionId(conv.activeExtensionId ?? null);
        setTaskStack((conv.taskStack as TaskStackEntry[]) ?? []);
        canvas.setCanvasSpec((conv.canvasState as Spec) ?? null);
        setChat({
          id: savedId,
          renderKey: 1,
          initialMessages: conv.messages as UIMessage[],
          savedTitle: conv.title,
        });
      })
      .catch((error) => {
        console.error("Failed to restore conversation:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist active chat ID
  useEffect(() => {
    localStorage.setItem(CHAT_ID_KEY, chat.id);
  }, [chat.id]);

  // When a new spec arrives from the AI stream, apply it through
  // applyStreamSpec so any locally-edited paths (form input, accepted
  // suggestion patches) are preserved instead of clobbered by the rebuild.
  const handleSpecFromStream = useCallback((spec: unknown) => {
    canvas.applyStreamSpec(spec);
    if (spec !== null) {
      canvas.open();
    }
  }, [canvas.applyStreamSpec, canvas.open]);

  const handleNewChat = useCallback(() => {
    setChat((prev) => ({ id: generateId(), renderKey: prev.renderKey + 1 }));
    canvas.setCanvasSpec(null);
    setActiveExtensionId(null);
    setTaskStack([]);
  }, [canvas.setCanvasSpec]);

  const handleSelectChat = useCallback(async (id: string) => {
    try {
      const conv = await getConversation(id);
      if (conv) {
        setChat((prev) => ({
          id,
          renderKey: prev.renderKey + 1,
          initialMessages: conv.messages as UIMessage[],
          savedTitle: conv.title,
        }));
        canvas.setCanvasSpec((conv.canvasState as Spec) ?? null);
        setActiveExtensionId(conv.activeExtensionId ?? null);
        setTaskStack((conv.taskStack as TaskStackEntry[]) ?? []);
      }
    } catch (error) {
      console.error("Failed to load conversation:", error);
    }
  }, [canvas.setCanvasSpec]);

  const handleConversationChange = useCallback(() => {
    setHistoryRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      {/* Background image + blur */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      {/* Content */}
      <NavPanel
        historyOpen={historyOpen}
        onChatClick={() => setHistoryOpen((prev) => !prev)}
      />

      <ChatHistoryPanel
        isOpen={historyOpen}
        activeChatId={chat.id}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        refreshKey={historyRefreshKey}
      />

      <div className="relative z-10 flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatPanel
            key={`${chat.id}-${chat.renderKey}`}
            chatId={chat.id}
            initialMessages={chat.initialMessages}
            savedTitle={chat.savedTitle}
            activeExtensionId={activeExtensionId}
            canvasState={canvas.canvasSpec}
            onCanvasStateChange={handleSpecFromStream}
            onExtensionChange={setActiveExtensionId}
            onConversationChange={handleConversationChange}
            onNewChat={handleNewChat}
            taskStack={taskStack}
            onTaskStackChange={setTaskStack}
            sendMessageRef={sendMessageRef}
            onCanvasStateWrite={canvas.mergeStateChanges}
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
          spec={canvas.canvasSpec}
          onStateChange={canvas.mergeStateChanges}
          onSendMessage={(text) => sendMessageRef.current?.(text)}
        />
      </div>
    </div>
  );
}
