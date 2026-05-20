"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { createDefinition, listDefinitions } from "@/lib/actions/definitions";
import { SNAKE_CASE_RE } from "../lib/constants";
import type { DimensionOption } from "../lib/types";
import { EntityCombobox } from "./EntityCombobox";
import { TypeCombobox } from "./TypeCombobox";

// ---- Dimension combobox with inline create ----
//
// Mirrors EntityCombobox but operates on dimensions. Used inside the Logger
// Table column popup so users can pick or create a dimension without leaving
// the table form. The create popover auto-fills source_table from the parent
// table name and source_column / data_type from the column being added, so
// the inline create only requires the user to confirm the entity + a short
// description.

export function DimensionCombobox({
  value,
  onChange,
  parentTableName,
  columnName,
  columnType,
}: {
  value: string;
  onChange: (v: string) => void;
  parentTableName: string;
  columnName: string;
  columnType: string;
}) {
  const [open, setOpen] = useState(false);
  const [dimensions, setDimensions] = useState<DimensionOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [newEntity, setNewEntity] = useState("");
  const [newSourceTable, setNewSourceTable] = useState("");
  const [newSourceColumn, setNewSourceColumn] = useState("");
  const [newDataType, setNewDataType] = useState("string");
  const [newDesc, setNewDesc] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const dimInvalid = value.length > 0 && !SNAKE_CASE_RE.test(value);

  const fetchDimensions = async () => {
    if (loaded) return;
    try {
      const defs = await listDefinitions("dimension");
      setDimensions(defs.map((d) => d.spec as DimensionOption));
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  };

  const filtered = dimensions.filter((d) => !value || d.name.includes(value.toLowerCase()));
  const exactMatch = dimensions.some((d) => d.name === value);
  const showCreateOption = !!value.trim() && !exactMatch && loaded && !dimInvalid;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
    setActiveIdx(0);
  };

  // Reset highlight to first item whenever the option list changes
  useEffect(() => {
    if (open && totalItems > 0) setActiveIdx(0);
    else setActiveIdx(-1);
  }, [open, totalItems, value]);

  // Seed the create popover defaults from the parent column context the
  // moment the user opens it, so the popover always reflects the latest
  // column name / type instead of stale state from a previous open.
  const openCreate = () => {
    setNewEntity("");
    setNewSourceTable(parentTableName || "");
    setNewSourceColumn(columnName || "");
    setNewDataType(columnType || "string");
    setNewDesc("");
    setCreateError(null);
    setCreating(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setCreating(false);
      return;
    }
    if (creating) return;
    if (!open || totalItems === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((prev) => (prev + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((prev) => (prev <= 0 ? totalItems - 1 : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const idx = activeIdx < 0 ? 0 : activeIdx;
      if (idx < filtered.length) select(filtered[idx].name);
      else if (showCreateOption) openCreate();
    }
  };

  const handleCreate = async () => {
    const name = value.trim();
    if (!name || submitting) return;
    if (!SNAKE_CASE_RE.test(name)) {
      setCreateError("Name must be snake_case");
      return;
    }
    if (!newEntity.trim()) {
      setCreateError("Entity is required");
      return;
    }
    if (!newSourceTable.trim()) {
      setCreateError("Source table is required");
      return;
    }
    if (!newSourceColumn.trim()) {
      setCreateError("Source column is required");
      return;
    }
    if (!newDataType.trim()) {
      setCreateError("Data type is required");
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      const spec = {
        name,
        description: newDesc.trim(),
        entity: newEntity.trim(),
        source_table: newSourceTable.trim(),
        source_column: newSourceColumn.trim(),
        data_type: newDataType,
      };
      await createDefinition({ kind: "dimension", name, spec });
      setDimensions((prev) => [...prev, spec as DimensionOption]);
      onChange(name);
      setCreating(false);
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create dimension. Please try again.";
      setCreateError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIdx(-1);
        }}
        onFocus={() => {
          fetchDimensions();
          setOpen(true);
          setActiveIdx(-1);
        }}
        onBlur={(e) => {
          if (!containerRef.current?.contains(e.relatedTarget)) {
            setTimeout(() => {
              setOpen(false);
              setCreating(false);
            }, 150);
          }
        }}
        onKeyDown={handleKeyDown}
        placeholder="Bind to dimension if applicable"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className={`flex-1 min-w-0 w-full bg-transparent text-xs text-stone-600 placeholder:text-stone-300 focus:outline-none ${dimInvalid ? "text-red-500" : ""}`}
      />
      {dimInvalid && <span className="text-[10px] text-red-500">Must be snake_case</span>}
      {open && loaded && totalItems > 0 && !creating && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[14rem] rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-44 overflow-y-auto">
          {filtered.map((d, i) => (
            <button
              key={d.name}
              onMouseDown={(e_) => {
                e_.preventDefault();
                select(d.name);
              }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : d.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono">{d.name}</span>
                <span className="text-stone-400">{d.entity}</span>
              </div>
              <div className="text-[9px] text-stone-400 truncate">
                {d.source_table}.{d.source_column}
              </div>
            </button>
          ))}
          {showCreateOption && (
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                openCreate();
              }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] border-t border-stone-100 transition-colors ${activeIdx === filtered.length ? "bg-stone-100 text-amber-700 font-medium" : "text-amber-600 hover:bg-stone-50"}`}
            >
              <Plus className="inline h-2.5 w-2.5 mr-0.5" />Create &ldquo;{value}&rdquo;
            </button>
          )}
        </div>
      )}
      {creating && (
        <div
          data-entity-popover
          className="absolute left-0 top-full z-30 mt-1 w-[18rem] rounded-xl border border-stone-200 bg-white shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setCreating(false);
              setOpen(false);
            }
          }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-100 rounded-t-xl">
            <span className="text-[10px] font-medium text-amber-700">
              Create Dimension &ldquo;{value}&rdquo;
            </span>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setCreating(false);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-amber-400 hover:text-amber-700 transition-colors"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 shrink-0 w-16">Entity:</span>
              <div className="flex-1">
                <EntityCombobox value={newEntity} onChange={setNewEntity} pkColumn="" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 shrink-0 w-16">Source tbl:</span>
              <input
                type="text"
                value={newSourceTable}
                onChange={(e) => setNewSourceTable(e.target.value)}
                placeholder="schema.table_name"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="flex-1 min-w-0 bg-transparent text-[10px] font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 shrink-0 w-16">Source col:</span>
              <input
                type="text"
                value={newSourceColumn}
                onChange={(e) => setNewSourceColumn(e.target.value)}
                placeholder="column_name"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="flex-1 min-w-0 bg-transparent text-[10px] font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 shrink-0 w-16">Data type:</span>
              <div className="flex-1">
                <TypeCombobox value={newDataType} onChange={setNewDataType} />
              </div>
            </div>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Describe this dimension..."
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              className="w-full bg-transparent text-[10px] text-stone-600 placeholder:text-stone-300 focus:outline-none border-t border-stone-100 pt-2"
            />
            {createError && (
              <div className="rounded-md bg-red-50 px-2 py-1 text-[10px] text-red-600 border border-red-100">
                {createError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1.5 border-t border-stone-100">
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setCreating(false);
                  setCreateError(null);
                }}
                className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
                disabled={submitting}
                className="rounded-full bg-stone-800 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-stone-700 transition-colors disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
