"use client";

import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { GitBranch, LogOut, MessageSquare } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavPanelProps {
  historyOpen?: boolean;
  onChatClick?: () => void;
}

// Set in Vercel env (and .env.local for dev) to point at the GitHub
// pipelines repo. NEXT_PUBLIC_ prefix is required so this is readable
// from the client component. If unset, we hide the shortcut entirely
// rather than dropping the user on a 404.
const PIPELINES_REPO_URL = process.env.NEXT_PUBLIC_PIPELINES_REPO_URL;

export function NavPanel({ historyOpen = false, onChatClick }: NavPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
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
              ? "bg-white/15 text-brand"
              : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
          onClick={handleChatClick}
        >
          <MessageSquare className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Chat History</TooltipContent>
      </Tooltip>

      {/* `mt-auto` lives on the first bottom-anchored item so the
          nav stays bottom-aligned whether or not the pipelines repo
          shortcut is rendered. */}
      {PIPELINES_REPO_URL && (
        <Tooltip>
          <TooltipTrigger
            className="mt-auto flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            onClick={() =>
              window.open(
                PIPELINES_REPO_URL,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <GitBranch className="h-5 w-5" />
          </TooltipTrigger>
          <TooltipContent side="right">Pipelines repo</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          className={`${PIPELINES_REPO_URL ? "" : "mt-auto "}flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white`}
          onClick={() => signOut({ redirectTo: "/sign-in" })}
        >
          <LogOut className="h-5 w-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Sign out</TooltipContent>
      </Tooltip>
    </nav>
  );
}
