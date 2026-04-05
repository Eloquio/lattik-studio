"use client";

import { Database, Clock, Fingerprint, CalendarDays } from "lucide-react";
import type { LoggerTable } from "../schema";

const IMPLICIT_COLUMNS = [
  { name: "event_id", type: "string", icon: "fingerprint" },
  { name: "event_timestamp", type: "timestamp", icon: "clock" },
  { name: "ds", type: "date", icon: "calendar" },
  { name: "hour", type: "int32", icon: "calendar" },
] as const;

interface LoggerTableCardProps {
  table: LoggerTable;
}

export function LoggerTableCard({ table }: LoggerTableCardProps) {
  return (
    <div className="rounded-lg border border-amber-300/50 bg-white/80 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-amber-200/50 px-3 py-2">
        <Database className="h-3.5 w-3.5 text-amber-600" />
        <span className="text-xs font-semibold text-amber-900">{table.name}</span>
        <div className="flex-1" />
        {table.retention && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono text-amber-700">
            {table.retention}
          </span>
        )}
        {table.dedup_window && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono text-amber-700">
            dedup {table.dedup_window}
          </span>
        )}
      </div>

      {/* Implicit columns */}
      <div className="px-3 pt-2 pb-1 space-y-1 border-b border-amber-200/30">
        {IMPLICIT_COLUMNS.map((col) => (
          <div key={col.name} className="flex items-center gap-2 text-[11px]">
            {col.icon === "fingerprint" ? (
              <Fingerprint className="h-3 w-3 text-amber-400 shrink-0" />
            ) : col.icon === "clock" ? (
              <Clock className="h-3 w-3 text-amber-400 shrink-0" />
            ) : (
              <CalendarDays className="h-3 w-3 text-amber-400 shrink-0" />
            )}
            <span className="font-mono text-amber-600">{col.name}</span>
            <span className="text-amber-500/50 font-mono">{col.type}</span>
            <span className="text-amber-400/60 text-[9px] italic">implicit</span>
          </div>
        ))}
      </div>

      {/* User-defined columns */}
      {table.columns.length > 0 && (
        <div className="px-3 py-2 space-y-1">
          {table.columns.map((col) => (
            <div key={col.name} className="flex items-center gap-2 text-[11px]">
              <div className="h-3 w-3 shrink-0" />
              <span className="font-mono text-amber-800">{col.name}</span>
              <span className="text-amber-600/60 font-mono">{col.type}</span>
              {col.entity && (
                <span className="rounded bg-amber-100/80 px-1 py-0.5 text-[9px] text-amber-600">
                  {col.entity}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
