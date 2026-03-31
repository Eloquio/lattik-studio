"use client";

import { MessageSquare, Store } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const navItems = [
  { icon: MessageSquare, label: "Chat History" },
  { icon: Store, label: "Marketplace" },
];

export function NavPanel() {
  return (
    <nav className="relative z-10 flex h-full w-14 flex-col items-center gap-2 border-r border-white/10 py-4">
      {navItems.map((item) => (
        <Tooltip key={item.label}>
          <TooltipTrigger
            className="flex h-10 w-10 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <item.icon className="h-5 w-5" />
          </TooltipTrigger>
          <TooltipContent side="right">{item.label}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );
}
