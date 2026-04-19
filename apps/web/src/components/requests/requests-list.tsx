"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Bot, User } from "lucide-react";
import type { RequestSource, RequestStatus } from "@/db/schema";

interface RequestListItem {
  id: string;
  source: RequestSource;
  description: string;
  status: RequestStatus;
  skillId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const STATUS_COLOR: Record<RequestStatus, string> = {
  pending: "bg-white/10 text-white/60",
  planning: "bg-sky-400/15 text-sky-300",
  awaiting_approval: "bg-amber-400/15 text-amber-300",
  approved: "bg-emerald-400/10 text-emerald-300/80",
  done: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
};

function formatRelative(date: Date | string) {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RequestsList({ requests }: { requests: RequestListItem[] }) {
  const params = useParams<{ id?: string }>();
  const selectedId = params?.id;

  return (
    <div className="relative z-10 flex h-full w-80 shrink-0 flex-col border-r border-white/10 bg-black/20 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
          Requests
        </span>
        <span className="text-[10px] text-white/30">{requests.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {requests.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-white/30">
            No requests yet
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {requests.map((req) => {
              const Icon = req.source === "webhook" ? Bot : User;
              const isSelected = selectedId === req.id;
              return (
                <Link
                  key={req.id}
                  href={`/requests/${req.id}`}
                  className={`group flex flex-col gap-1 rounded-lg px-3 py-2 transition-colors ${
                    isSelected
                      ? "bg-white/10 text-white"
                      : "text-white/70 hover:bg-white/5 hover:text-white/90"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      className={`h-3.5 w-3.5 shrink-0 ${
                        isSelected ? "text-[#e0a96e]" : "text-white/40"
                      }`}
                    />
                    <span className="flex-1 truncate text-xs">
                      {req.description}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 pl-5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLOR[req.status]}`}
                    >
                      {req.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-[10px] text-white/30">
                      {formatRelative(req.createdAt)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
