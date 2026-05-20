"use client";

import { Lock } from "lucide-react";

export function ImplicitRow({
  name,
  type,
  description,
  highlighted,
  onHover,
  onLeave,
}: {
  name: string;
  type: string;
  description?: string;
  highlighted?: boolean;
  onHover?: () => void;
  onLeave?: () => void;
}) {
  return (
    <tr
      className={`border-b border-stone-100 transition-colors ${highlighted ? "bg-amber-50" : "bg-stone-50/50"}`}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      <td className={`px-2.5 py-1.5 font-mono text-xs ${highlighted ? "text-amber-700" : "text-stone-400"}`}>{name}</td>
      <td className={`px-2.5 py-1.5 text-xs uppercase ${highlighted ? "text-amber-600" : "text-stone-400"}`}>{type}</td>
      <td className="px-2.5 py-1.5 text-[10px] text-stone-400/70">{description}</td>
      <td className="px-2.5 py-1.5 w-8" title="System column — cannot be modified">
        <Lock className="h-3 w-3 text-stone-300" />
      </td>
    </tr>
  );
}
