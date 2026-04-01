"use client";

import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { generateId } from "ai";
import { NavPanel } from "@/components/layout/nav-panel";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ChatHistoryPanel } from "@/components/chat/chat-history-panel";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { useCanvas } from "@/hooks/use-canvas";
import { getConversation } from "@/lib/actions/conversations";

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
        }
      }).catch(() => {});
    }
  }, []);

  // Persist active chat ID
  useEffect(() => {
    localStorage.setItem(CHAT_ID_KEY, chat.id);
  }, [chat.id]);

  const handleNewChat = useCallback(() => {
    setChat((prev) => ({ id: generateId(), renderKey: prev.renderKey + 1 }));
    canvas.setCanvasState(null);
    setActiveExtensionId(null);
  }, [canvas]);

  const handleSelectChat = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      setChat((prev) => ({
        id,
        renderKey: prev.renderKey + 1,
        initialMessages: conv.messages as UIMessage[],
        savedTitle: conv.title,
      }));
      canvas.setCanvasState(null);
      setActiveExtensionId(null);
    }
  }, [canvas]);

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
            onCanvasStateChange={canvas.setCanvasState}
            onExtensionChange={setActiveExtensionId}
            onConversationChange={handleConversationChange}
            onNewChat={handleNewChat}
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
