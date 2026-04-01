"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Pencil, Plus, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import { saveConversation, deleteConversation } from "@/lib/actions/conversations";

interface ChatPanelProps {
  chatId: string;
  initialMessages?: UIMessage[];
  savedTitle?: string;
  activeExtensionId: string | null;
  onCanvasStateChange: (state: unknown) => void;
  onExtensionChange: (id: string | null) => void;
  onConversationChange?: () => void;
  onNewChat?: () => void;
}

export function ChatPanel({
  chatId,
  initialMessages,
  savedTitle,
  activeExtensionId,
  onCanvasStateChange,
  onExtensionChange,
  onConversationChange,
  onNewChat,
}: ChatPanelProps) {
  const extensionIdRef = useRef(activeExtensionId);
  extensionIdRef.current = activeExtensionId;

  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        body: () => ({ extensionId: extensionIdRef.current }),
      })
  );

  const { messages, sendMessage, status } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
  });
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "submitted" || status === "streaming";
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-save conversation when assistant finishes responding
  useEffect(() => {
    if (wasLoadingRef.current && status === "ready" && messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.role === "user");
      const title = firstUserMsg
        ? firstUserMsg.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ")
            .slice(0, 100) || "New Chat"
        : "New Chat";

      saveConversation({ id: chatId, title, messages });
      onConversationChange?.();
    }
    wasLoadingRef.current = isLoading;
  }, [status, messages, chatId, isLoading, onConversationChange]);

  // Handle handoff tool calls — switch to the target agent
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          part.type === "tool-handoff" &&
          "state" in part &&
          "input" in part &&
          part.state === "input-available"
        ) {
          const input = part.input as { agentId: string };
          if (input.agentId && input.agentId !== activeExtensionId) {
            onExtensionChange(input.agentId);
          }
          return;
        }
      }
    }
  }, [messages, activeExtensionId, onExtensionChange]);

  // Extract canvas state from tool results
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          part.type === "tool-updatePipeline" &&
          "state" in part &&
          part.state === "output-available" &&
          "output" in part
        ) {
          onCanvasStateChange(part.output);
          return;
        }
      }
    }
  }, [messages, onCanvasStateChange]);

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  };

  const handleDelete = async () => {
    await deleteConversation(chatId);
    onConversationChange?.();
    onNewChat?.();
  };

  const displayTitle = savedTitle || "New Chat";

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Chat title */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5" style={{ height: "49px" }}>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#e0a96e]" />
          <span className="text-sm font-medium text-white/70">
            {activeExtensionId === "data-architect" ? "Data Architect" : "Lattik Studio Assistant"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-white/50 truncate max-w-[200px]">{displayTitle}</span>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-white/60" title="Edit title">
            <Pencil className="h-3 w-3" />
          </button>
          {messages.length > 0 && (
            <>
              <button
                onClick={onNewChat}
                className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
                title="New Chat"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={handleDelete}
                className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-red-400"
                title="Delete conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <h2 className="text-2xl font-bold text-white tracking-tight">
              <span style={{ fontFamily: "var(--font-display), cursive" }}>Lattik<span className="text-[#e0a96e]"> Studio</span></span>
            </h2>
            <p className="text-sm text-white/50">Start a conversation...</p>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "user" ? (
                  <div className="max-w-[80%] rounded-2xl bg-white/15 px-4 py-2.5 text-sm text-white">
                    {message.parts.map((part, i) =>
                      part.type === "text" ? (
                        <p key={i} className="whitespace-pre-wrap">{part.text}</p>
                      ) : null
                    )}
                  </div>
                ) : (
                  <div className="w-full">
                    <span className="text-xs font-semibold text-[#e0a96e]">
                      {activeExtensionId === "data-architect" ? "Data Architect" : "Assistant"}
                    </span>
                    <div className="mt-1 border-l-2 border-[#e0a96e]/40 pl-4 text-sm text-white/90 prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:text-white prose-strong:text-white prose-code:text-[#e0a96e] prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10">
                      {message.parts.map((part, i) =>
                        part.type === "text" ? (
                          <Markdown key={i}>{part.text}</Markdown>
                        ) : null
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="p-4">
        <div className="relative rounded-2xl border border-white/15 bg-white/10 backdrop-blur-md">
          <textarea
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type something..."
            className="w-full resize-none bg-transparent px-4 pt-3 pb-10 text-sm text-white placeholder:text-white/40 focus:outline-none"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={isLoading || !input.trim()}
            className="absolute right-3 bottom-3 flex h-7 w-7 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white/60 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
