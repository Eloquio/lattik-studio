"use client";

import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { LogOut, MessageSquare, Store } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavPanelProps {
  historyOpen: boolean;
  onChatClick: () => void;
}

export function NavPanel({ historyOpen, onChatClick }: NavPanelProps) {
  const router = useRouter();

  return (
    <nav className="relative z-10 flex h-full w-14 flex-col items-center gap-2 border-r border-white/10 py-4">
      <Tooltip>
        <TooltipTrigger
          className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            historyOpen
              ? "bg-white/15 text-[#e0a96e]"
              : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
          onClick={onChatClick}
        >
          <MessageSquare className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Chat History</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className="flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => router.push("/marketplace")}
        >
          <Store className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Marketplace</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className="mt-auto flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => signOut({ redirectTo: "/sign-in" })}
        >
          <LogOut className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Sign out</TooltipContent>
      </Tooltip>
    </nav>
  );
}
