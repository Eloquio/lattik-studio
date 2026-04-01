"use client";

import { useEffect, useState, useTransition } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import {
  listConversations,
  deleteConversation,
} from "@/lib/actions/conversations";

interface ChatHistoryPanelProps {
  isOpen: boolean;
  activeChatId: string;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  refreshKey: number;
}

interface ConversationItem {
  id: string;
  title: string;
  updatedAt: Date;
}

export function ChatHistoryPanel({
  isOpen,
  activeChatId,
  onSelectChat,
  onNewChat,
  refreshKey,
}: ChatHistoryPanelProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      try {
        const data = await listConversations();
        setConversations(data);
      } catch {}
    });
  }, [refreshKey]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    startTransition(async () => {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeChatId) {
        onNewChat();
      }
    });
  };

  if (!isOpen) return null;

  return (
    <div className="relative z-10 flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-black/20 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
          History
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-white/30">
            No conversations yet
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => onSelectChat(conv.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                  activeChatId === conv.id
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:bg-white/5 hover:text-white/80"
                }`}
              >
                <MessageSquare
                  className={`h-3.5 w-3.5 shrink-0 ${
                    activeChatId === conv.id
                      ? "text-[#e0a96e]"
                      : "text-white/40"
                  }`}
                />
                <span className="flex-1 truncate text-xs">{conv.title}</span>
                <button
                  onClick={(e) => handleDelete(e, conv.id)}
                  className="hidden shrink-0 rounded p-0.5 text-white/30 transition-colors hover:bg-white/10 hover:text-red-400 group-hover:block"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
