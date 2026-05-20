"use client";

import { useEffect, useRef, useState } from "react";
import { lookupCatalogTable } from "@/lib/actions/iceberg-catalog";
import { listDefinitions } from "@/lib/actions/definitions";
import type { SourceTableOption, TableStatus } from "../lib/types";

export function SourceTableCombobox({
  value,
  onChange,
  onColumnsLoaded,
}: {
  value: string;
  onChange: (v: string) => void;
  onColumnsLoaded: (cols: { name: string; type: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<SourceTableOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [catalogStatus, setCatalogStatus] = useState<TableStatus>("idle");
  const catalogCacheRef = useRef<
    Map<string, { exists: boolean; columns: { name: string; type: string }[] }>
  >(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchTables = async () => {
    if (loaded) return;
    try {
      const [loggers, lattiks] = await Promise.all([
        listDefinitions("logger_table"),
        listDefinitions("lattik_table"),
      ]);
      const all: SourceTableOption[] = [
        ...loggers.map((d) => {
          const s = d.spec as { name: string; columns?: { name: string; type: string }[] };
          return {
            name: s.name,
            kind: "logger",
            columns: (s.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
          };
        }),
        ...lattiks.map((d) => {
          const s = d.spec as {
            name: string;
            column_families?: { columns: { name: string; type?: string }[] }[];
            derived_columns?: { name: string }[];
          };
          const cols = [
            ...(s.column_families ?? []).flatMap((f) =>
              f.columns.map((c) => ({ name: c.name, type: c.type ?? "unknown" })),
            ),
            ...(s.derived_columns ?? []).map((c) => ({ name: c.name, type: "expr" })),
          ];
          return { name: s.name, kind: "lattik", columns: cols };
        }),
      ];
      setTables(all);
      setLoaded(true);
      const match = all.find((t) => t.name === value);
      if (match) {
        onColumnsLoaded(match.columns);
        setCatalogStatus("definition");
      }
    } catch {
      setLoaded(true);
    }
  };

  // Catalog fallback: debounced lookup when value doesn't match any definition
  const checkCatalog = (name: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!name.trim() || !name.includes(".")) {
      setCatalogStatus("idle");
      return;
    }
    // Check cache first
    const cached = catalogCacheRef.current.get(name);
    if (cached) {
      if (cached.exists) {
        setCatalogStatus("catalog");
        onColumnsLoaded(cached.columns);
      } else setCatalogStatus("not_found");
      return;
    }
    setCatalogStatus("loading");
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await lookupCatalogTable(name);
        catalogCacheRef.current.set(name, result);
        if (result.exists) {
          setCatalogStatus("catalog");
          onColumnsLoaded(result.columns);
        } else setCatalogStatus("not_found");
      } catch {
        setCatalogStatus("not_found");
      }
    }, 400);
  };

  const filtered = tables.filter(
    (t) => !value || t.name.toLowerCase().includes(value.toLowerCase()),
  );
  const defMatch = tables.find((t) => t.name === value);

  const select = (t: SourceTableOption) => {
    onChange(t.name);
    onColumnsLoaded(t.columns);
    setCatalogStatus("definition");
    setOpen(false);
    setActiveIdx(-1);
  };

  useEffect(() => {
    if (open && filtered.length > 0) setActiveIdx(0);
    else setActiveIdx(-1);
  }, [open, filtered.length, value]);

  // Resolve table status when value changes
  useEffect(() => {
    if (!value.trim() || !loaded) {
      setCatalogStatus("idle");
      return;
    }
    if (defMatch) {
      onColumnsLoaded(defMatch.columns);
      setCatalogStatus("definition");
    } else checkCatalog(value);
  }, [value, loaded]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((prev) => (prev + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const idx = activeIdx < 0 ? 0 : activeIdx;
      if (idx < filtered.length) select(filtered[idx]);
    }
  };

  const badge = (() => {
    if (!value.trim() || !loaded) return null;
    switch (catalogStatus) {
      case "definition":
        return (
          <span className="shrink-0 rounded bg-green-50 px-1 py-0.5 text-[9px] font-medium text-green-600 ring-1 ring-green-200/50">
            definition
          </span>
        );
      case "catalog":
        return (
          <span className="shrink-0 rounded bg-blue-50 px-1 py-0.5 text-[9px] font-medium text-blue-600 ring-1 ring-blue-200/50">
            catalog
          </span>
        );
      case "loading":
        return (
          <span className="shrink-0 rounded bg-stone-50 px-1 py-0.5 text-[9px] font-medium text-stone-400 ring-1 ring-stone-200/50">
            checking...
          </span>
        );
      case "not_found":
        return (
          <span className="shrink-0 rounded bg-red-50 px-1 py-0.5 text-[9px] font-medium text-red-500 ring-1 ring-red-200/50">
            not found
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActiveIdx(-1);
          }}
          onFocus={() => {
            fetchTables();
            setOpen(true);
          }}
          onBlur={(e) => {
            if (!containerRef.current?.contains(e.relatedTarget))
              setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder="e.g. ingest.click_events"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          className="w-full bg-transparent text-xs font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none"
        />
        {badge}
      </div>
      {open && loaded && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((t, i) => (
            <button
              key={t.name}
              onMouseDown={(e) => {
                e.preventDefault();
                select(t);
              }}
              className={`block w-full px-2.5 py-1 text-left text-xs transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : t.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}
            >
              <span className="font-mono">{t.name}</span>
              <span className="ml-1.5 text-[9px] text-stone-400">{t.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
