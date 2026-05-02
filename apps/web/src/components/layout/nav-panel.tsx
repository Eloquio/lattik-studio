"use client";

import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Cpu, GitBranch, Inbox, LogOut, MessageSquare } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavPanelProps {
  historyOpen?: boolean;
  onChatClick?: () => void;
}

export function NavPanel({ historyOpen = false, onChatClick }: NavPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const onRequests = pathname.startsWith("/requests");
  const onWorkers = pathname.startsWith("/settings/workers");
  const onHome = pathname === "/";

  const handleChatClick = () => {
    if (onChatClick) onChatClick();
    else router.push("/");
  };

  return (
    <nav className="relative z-10 flex h-full w-14 flex-col items-center gap-2 border-r border-white/10 py-4">
      <Tooltip>
        <TooltipTrigger
          className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            onHome && historyOpen
              ? "bg-white/15 text-[#e0a96e]"
              : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
          onClick={handleChatClick}
        >
          <MessageSquare className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Chat History</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            onRequests
              ? "bg-white/15 text-[#e0a96e]"
              : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
          onClick={() => router.push("/requests")}
        >
          <Inbox className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Requests</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            onWorkers
              ? "bg-white/15 text-[#e0a96e]"
              : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
          onClick={() => router.push("/settings/workers")}
        >
          <Cpu className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Workers</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className="mt-auto flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() =>
            window.open(
              "http://localhost:3300/lattik/pipelines",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <GitBranch className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Gitea</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          className="flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => signOut({ redirectTo: "/sign-in" })}
        >
          <LogOut className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Sign out</TooltipContent>
      </Tooltip>
    </nav>
  );
}
