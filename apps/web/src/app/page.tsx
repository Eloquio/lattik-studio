"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [activeExtensionId, setActiveExtensionId] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<TaskStackEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [chat, setChat] = useState<ChatState>(() => ({
    id: (typeof window !== "undefined" && localStorage.getItem(CHAT_ID_KEY)) || generateId(),
    renderKey: 0,
  }));

  // Restore last conversation on mount
  useEffect(() => {
    const savedId = localStorage.getItem(CHAT_ID_KEY);
    if (savedId) {
      getConversation(savedId).then((conv) => {
        if (conv && Array.isArray(conv.messages)) {
          setChat({
            id: savedId,
            renderKey: 1,
            initialMessages: conv.messages as UIMessage[],
            savedTitle: conv.title,
          });
          if (conv.canvasState) {
            canvas.setCanvasSpec(conv.canvasState as Spec);
          }
          if (conv.taskStack) {
            setTaskStack(conv.taskStack as TaskStackEntry[]);
          }
          if (conv.activeExtensionId) {
            setActiveExtensionId(conv.activeExtensionId);
          }
        }
      }).catch((error) => {
        console.error("Failed to restore conversation:", error);
      });
    }
  }, []);

  // Persist active chat ID
  useEffect(() => {
    localStorage.setItem(CHAT_ID_KEY, chat.id);
  }, [chat.id]);

  // When a new spec arrives from the AI stream, set it and open the canvas
  const handleSpecFromStream = useCallback((spec: unknown) => {
    canvas.setCanvasSpec(spec as Spec | null);
    if (spec !== null) {
      canvas.open();
    }
  }, [canvas.setCanvasSpec, canvas.open]);

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
        />
      </div>
    </div>
  );
}
