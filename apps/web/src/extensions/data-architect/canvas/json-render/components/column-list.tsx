"use client";

import { Plus, Trash2 } from "lucide-react";
import type { JsonRenderComponentProps } from "../types";

interface Column {
  name: string;
  type: string;
  entity?: string;
  nullable?: boolean;
  description?: string;
}

export function ColumnList({ props, state, onStateChange }: JsonRenderComponentProps) {
  const label = props.label as string | undefined;
  const field = props.field as string;
  const typeOptions = (props.typeOptions as string[]) ?? [
    "string", "int32", "int64", "float", "double", "boolean", "timestamp", "date", "json",
  ];

  const columns = (state[field] as Column[]) ?? [];

  function updateColumn(index: number, patch: Partial<Column>) {
    const updated = columns.map((col, i) =>
      i === index ? { ...col, ...patch } : col
    );
    onStateChange(field, updated);
  }

  function addColumn() {
    onStateChange(field, [...columns, { name: "", type: "string" }]);
  }

  function removeColumn(index: number) {
    onStateChange(field, columns.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            {label}
          </span>
          <button
            onClick={addColumn}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      )}
      {columns.map((col, i) => (
        <div
          key={i}
          className="flex items-start gap-1.5 rounded-md border border-amber-200/30 bg-white/60 px-2 py-1.5"
        >
          <input
            type="text"
            value={col.name}
            onChange={(e) => updateColumn(i, { name: e.target.value })}
            placeholder="column_name"
            className="flex-1 min-w-0 rounded border-0 bg-transparent px-1 py-0.5 text-xs font-mono text-amber-900 placeholder:text-amber-400/50 focus:outline-none"
          />
          <select
            value={col.type}
            onChange={(e) => updateColumn(i, { type: e.target.value })}
            className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-amber-700 focus:outline-none"
          >
            {typeOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            onClick={() => removeColumn(i)}
            className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      {columns.length === 0 && (
        <button
          onClick={addColumn}
          className="rounded-md border border-dashed border-amber-300/50 px-3 py-2 text-xs text-amber-600/60 hover:bg-amber-50/50 transition-colors"
        >
          Add first column...
        </button>
      )}
    </div>
  );
}
