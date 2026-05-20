"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { createDefinition, listDefinitions } from "@/lib/actions/definitions";
import { useEntityRegistry } from "../entity-registry-context";
import { inputCls } from "../lib/constants";
import type { EntityOption } from "../lib/types";
import { TypeCombobox } from "./TypeCombobox";

export function EntityCombobox({
  value,
  onChange,
  pkColumn,
  onSubmit,
  variant = "pill",
}: {
  value: string;
  onChange: (v: string) => void;
  pkColumn: string;
  onSubmit?: () => void;
  variant?: "pill" | "default";
}) {
  const { refresh: refreshRegistry } = useEntityRegistry();
  const [open, setOpen] = useState(false);
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newIdType, setNewIdType] = useState("string");
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchEntities = async () => {
    if (loaded) return;
    try {
      const defs = await listDefinitions("entity");
      setEntities(defs.map((d) => d.spec as EntityOption));
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  };

  const filtered = entities.filter((e) => !value || e.name.includes(value.toLowerCase()));
  const exactMatch = entities.some((e) => e.name === value);
  const showCreateOption = !!value.trim() && !exactMatch && loaded;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
    setActiveIdx(0);
    onSubmit?.();
  };

  // Reset highlight to first item whenever the option list changes
  useEffect(() => {
    if (open && totalItems > 0) setActiveIdx(0);
    else setActiveIdx(-1);
  }, [open, totalItems, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setCreating(false);
      return;
    }
    if (creating) return;
    if (!open || totalItems === 0) {
      // Dropdown closed: Enter exits edit mode
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onSubmit?.();
      }
      return;
    }
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
      else if (showCreateOption) setCreating(true);
    }
  };

  const inferredIdField = pkColumn || `${value}_id`;

  const handleCreate = async () => {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      await createDefinition({
        kind: "entity",
        name: value.trim(),
        spec: {
          name: value.trim(),
          description: newDesc.trim(),
          id_field: inferredIdField,
          id_type: newIdType,
        },
      });
      setEntities((prev) => [...prev, { name: value.trim(), id_field: inferredIdField, id_type: newIdType }]);
      refreshRegistry();
      setCreating(false);
      setOpen(false);
      setNewDesc("");
      setNewIdType("string");
    } catch (err) {
      // Surface failures rather than swallowing them. The previous "silent —
      // will fail at static check" path was misleading: static check runs
      // *after* the entity is supposed to exist, so the user lost the
      // entity-create attempt without ever knowing.
      const message =
        err instanceof Error ? err.message : "Failed to create entity. Please try again.";
      setCreateError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // Variant-specific styling. The "pill" variant is the compact form used
  // inside the lattik-table primary-key pill (tight spacing, blue text). The
  // "default" variant is the full-size bordered input used in standalone form
  // fields (DimensionForm.entity, DimensionCombobox create popover, etc.).
  const isDefault = variant === "default";
  const inputClass = isDefault
    ? inputCls
    : "w-14 bg-transparent text-[10px] text-blue-600 placeholder:text-stone-400 focus:outline-none";
  const placeholder = isDefault ? "e.g. user" : "entity";

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
          fetchEntities();
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
        placeholder={placeholder}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className={inputClass}
      />
      {open && loaded && totalItems > 0 && !creating && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[10rem] rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((e, i) => (
            <button
              key={e.name}
              onMouseDown={(e_) => {
                e_.preventDefault();
                select(e.name);
              }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : e.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}
            >
              <span className="font-mono">{e.name}</span>
              <span className="ml-1.5 text-stone-400">{e.id_field}</span>
            </button>
          ))}
          {showCreateOption && (
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setCreating(true);
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
          className="absolute left-0 top-full z-30 mt-1 w-[16rem] rounded-xl border border-stone-200 bg-white shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setCreating(false);
              setOpen(false);
            }
            if (e.key === "Enter") {
              e.preventDefault();
              handleCreate();
            }
          }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-100 rounded-t-xl">
            <span className="text-[10px] font-medium text-amber-700">Create Entity &ldquo;{value}&rdquo;</span>
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
            <div className="flex items-center gap-2 text-[10px] text-stone-500">
              <span className="text-stone-400">ID field:</span>
              <span className="font-mono text-stone-700">{inferredIdField}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 shrink-0">ID type:</span>
              <TypeCombobox value={newIdType} onChange={(v) => setNewIdType(v)} />
            </div>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Describe this entity..."
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              className="w-full bg-transparent text-[10px] text-stone-600 placeholder:text-stone-300 focus:outline-none"
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
