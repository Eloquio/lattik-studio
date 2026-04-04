"use client";

import type { Entity } from "../schema";

interface EntityChipProps {
  entity: Entity;
}

export function EntityChip({ entity }: EntityChipProps) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-100/80 px-3 py-1">
      <span className="text-xs font-semibold text-amber-900">{entity.name}</span>
      <span className="text-[10px] font-mono text-amber-700/70">{entity.id_field} ({entity.id_type})</span>
    </div>
  );
}
