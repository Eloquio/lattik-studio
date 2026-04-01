"use client";

import { Database, Clock, Key } from "lucide-react";
import type { LoggerTable } from "../schema";

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

      {/* Columns */}
      <div className="px-3 py-2 space-y-1">
        {table.columns.map((col) => {
          const isPk = table.primary_key.some((pk) => pk.column === col.name);
          const isTimestamp = col.name === table.event_timestamp;
          return (
            <div key={col.name} className="flex items-center gap-2 text-[11px]">
              {isPk ? (
                <Key className="h-3 w-3 text-amber-500 shrink-0" />
              ) : isTimestamp ? (
                <Clock className="h-3 w-3 text-amber-500 shrink-0" />
              ) : (
                <div className="h-3 w-3 shrink-0" />
              )}
              <span className={`font-mono ${isPk ? "font-semibold text-amber-900" : "text-amber-800"}`}>
                {col.name}
              </span>
              <span className="text-amber-600/60 font-mono">{col.type}</span>
              {col.entity && (
                <span className="rounded bg-amber-100/80 px-1 py-0.5 text-[9px] text-amber-600">
                  {col.entity}
                </span>
              )}
              {col.nullable && (
                <span className="text-amber-500/50 text-[9px]">null</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
