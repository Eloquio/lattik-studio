"use client";

import { Table2, Key, ArrowRight } from "lucide-react";
import type { LattikTable } from "../schema";

interface LattikTableCardProps {
  table: LattikTable;
}

export function LattikTableCard({ table }: LattikTableCardProps) {
  return (
    <div className="rounded-lg border border-indigo-300/50 bg-white/80 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-indigo-200/50 px-3 py-2">
        <Table2 className="h-3.5 w-3.5 text-indigo-600" />
        <span className="text-xs font-semibold text-indigo-900">{table.name}</span>
      </div>

      {/* Primary Key */}
      {table.primary_key.length > 0 && (
        <div className="border-b border-indigo-100/50 px-3 py-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {table.primary_key.map((pk) => (
              <div key={pk.column} className="flex items-center gap-1 text-[11px]">
                <Key className="h-3 w-3 text-indigo-400" />
                <span className="font-mono font-semibold text-indigo-900">{pk.column}</span>
                <span className="rounded bg-indigo-100/80 px-1 py-0.5 text-[9px] text-indigo-600">
                  {pk.entity}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Column Families */}
      {table.column_families.map((cf) => (
        <div key={cf.name} className="border-b border-indigo-100/30 px-3 py-2 last:border-b-0">
          <div className="flex items-center gap-1.5 mb-1.5">
            <ArrowRight className="h-3 w-3 text-violet-500" />
            <span className="text-[10px] font-semibold text-violet-700">{cf.name}</span>
            <span className="text-[10px] text-violet-500/70">from {cf.source}</span>
          </div>

          {/* Key mapping */}
          {Object.keys(cf.key_mapping).length > 0 && (
            <div className="mb-1 flex flex-wrap gap-1">
              {Object.entries(cf.key_mapping).map(([to, from]) => (
                <span key={to} className="text-[9px] font-mono text-violet-500/60">
                  {to}={from}
                </span>
              ))}
            </div>
          )}

          {/* Columns */}
          <div className="space-y-0.5">
            {cf.columns.map((col) => (
              <div key={col.name} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-indigo-800">{col.name}</span>
                {col.agg && (
                  <span className="font-mono text-violet-600/70">{col.agg}</span>
                )}
                {col.merge && (
                  <span className="rounded bg-violet-100/60 px-1 py-0.5 text-[9px] text-violet-600">
                    {col.merge}
                  </span>
                )}
                {col.expr && (
                  <span className="font-mono text-violet-600/70">{col.expr}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Derived columns */}
      {table.derived_columns && table.derived_columns.length > 0 && (
        <div className="border-t border-indigo-200/40 px-3 py-2">
          <div className="text-[10px] font-semibold text-indigo-600/70 mb-1">Derived</div>
          <div className="space-y-0.5">
            {table.derived_columns.map((col) => (
              <div key={col.name} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-indigo-800">{col.name}</span>
                <span className="font-mono text-indigo-500/60">{col.expr}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
