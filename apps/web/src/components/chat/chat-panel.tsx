"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Pencil } from "lucide-react";

export function ChatPanel() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Chat title */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5" style={{ height: "49px" }}>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#e0a96e]" />
          <span className="text-sm font-medium text-white/70">AI Assistant</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-white/50">New Chat</span>
          <button className="text-white/30 transition-colors hover:text-white/60">
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <h2 className="text-2xl font-bold text-white tracking-tight">
              <span style={{ fontFamily: "var(--font-display), cursive" }}>AI<span className="text-[#e0a96e]"> Chat</span></span>
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
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm ${
                    message.role === "user"
                      ? "max-w-[80%] bg-white/15 text-white"
                      : "w-full text-white/90"
                  }`}
                >
                  {message.parts.map((part, i) =>
                    part.type === "text" ? (
                      <p key={i} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    ) : null
                  )}
                </div>
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
            onClick={handleSubmit}
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
