"use client";

import { useEffect, useRef, useState } from "react";
import { defineRegistry, useStateStore } from "@json-render/react";
import { Check, X, Plus, Trash2, Lock, Table2, Send, FileCode, PartyPopper, GitPullRequest, GitBranch, ExternalLink } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { useCanvasActions } from "@/components/canvas/canvas-actions-context";
import type { ScalarTypeKind } from "@eloquio/lattik-expression";
import { fromColumnType, parse, KNOWN_AGGREGATES } from "@eloquio/lattik-expression";
import { listDefinitions, createDefinition } from "@/lib/actions/definitions";
import { lookupCatalogTable } from "@/lib/actions/iceberg-catalog";
import type { Classification } from "../schema";
import { useEntityRegistry } from "./entity-registry-context";
import { catalog } from "./catalog";

// ---- Classification helpers ----
// Compliance flags shown on each column. Order here drives the popup pill
// order and the badge order on column rows, so keep it stable.
const CLASSIFICATION_CATEGORIES: ReadonlyArray<{
  key: keyof Classification;
  label: string;
  badgeCls: string;
  pillActiveCls: string;
}> = [
  { key: "pii", label: "PII", badgeCls: "bg-red-100 text-red-600", pillActiveCls: "bg-red-100 text-red-600 ring-1 ring-red-200" },
  { key: "phi", label: "PHI", badgeCls: "bg-purple-100 text-purple-600", pillActiveCls: "bg-purple-100 text-purple-600 ring-1 ring-purple-200" },
  { key: "financial", label: "Financial", badgeCls: "bg-emerald-100 text-emerald-700", pillActiveCls: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200" },
  { key: "credentials", label: "Credentials", badgeCls: "bg-orange-100 text-orange-700", pillActiveCls: "bg-orange-100 text-orange-700 ring-1 ring-orange-200" },
];

function toggleClassification(c: Classification | undefined, key: keyof Classification): Classification | undefined {
  const next: Classification = { ...(c ?? {}) };
  if (next[key]) delete next[key]; else next[key] = true;
  return Object.keys(next).length > 0 ? next : undefined;
}

// ---- State helper hook ----
function useField(field: string) {
  const store = useStateStore();
  const value = store.get(`/${field}`);
  const set = (v: unknown) => store.set(`/${field}`, v);
  return [value, set] as const;
}

// ---- Shared styles ----
const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500/30";

// ---- Column helpers ----
interface UserColumn { _key: string; name: string; type: string; description?: string; dimension?: string; classification?: Classification; tags?: string[] }
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const TYPE_OPTIONS: ScalarTypeKind[] = ["string", "int32", "int64", "float", "double", "boolean", "timestamp", "date", "json"];

function TypeCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(value);
  const [activeIdx, setActiveIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const filtered = TYPE_OPTIONS.filter((t) => t.includes(input.toLowerCase()) || t.toUpperCase().includes(input.toUpperCase()));
  const resolved = fromColumnType(input);
  const isValid = resolved !== "unknown" || input === "";

  const select = (t: string) => { setInput(t); onChange(t); setOpen(false); setActiveIdx(-1); };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      if (activeIdx >= 0 && activeIdx < filtered.length) {
        select(filtered[activeIdx]);
      } else if (filtered.length === 1) {
        select(filtered[0]);
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <input type="text" value={input.toUpperCase()}
        onChange={(e) => { const v = e.target.value.toLowerCase(); setInput(v); onChange(v); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => { setOpen(true); setActiveIdx(-1); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
        placeholder="What's the data type of this column?"
        className={`w-full bg-transparent text-xs text-stone-600 placeholder:text-stone-300 placeholder:normal-case focus:outline-none ${input ? "uppercase" : ""} ${!isValid && input ? "text-red-500" : ""}`} />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((t, i) => (
            <button key={t} onMouseDown={(e) => { e.preventDefault(); select(t); }}
              className={`block w-full px-2.5 py-1 text-left text-xs uppercase transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : t === input ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}>
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
let _nextKey = 0;
function genKey(prefix = "k") { return `${prefix}_${++_nextKey}_${Date.now()}`; }

// ---- Entity combobox with inline create ----
interface EntityOption { name: string; id_field: string; id_type: string }

function EntityCombobox({ value, onChange, pkColumn, onSubmit, variant = "pill" }: { value: string; onChange: (v: string) => void; pkColumn: string; onSubmit?: () => void; variant?: "pill" | "default" }) {
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
    } catch { setLoaded(true); }
  };

  const filtered = entities.filter((e) => !value || e.name.includes(value.toLowerCase()));
  const exactMatch = entities.some((e) => e.name === value);
  const showCreateOption = !!value.trim() && !exactMatch && loaded;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  const select = (name: string) => { onChange(name); setOpen(false); setActiveIdx(0); onSubmit?.(); };

  // Reset highlight to first item whenever the option list changes
  useEffect(() => {
    if (open && totalItems > 0) setActiveIdx(0);
    else setActiveIdx(-1);
  }, [open, totalItems, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); setCreating(false); return; }
    if (creating) return;
    if (!open || totalItems === 0) {
      // Dropdown closed: Enter exits edit mode
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSubmit?.(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((prev) => (prev + 1) % totalItems); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((prev) => (prev <= 0 ? totalItems - 1 : prev - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
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
      await createDefinition({ kind: "entity", name: value.trim(), spec: { name: value.trim(), description: newDesc.trim(), id_field: inferredIdField, id_type: newIdType } });
      setEntities((prev) => [...prev, { name: value.trim(), id_field: inferredIdField, id_type: newIdType }]);
      refreshRegistry();
      setCreating(false); setOpen(false); setNewDesc(""); setNewIdType("string");
    } catch (err) {
      // Surface failures rather than swallowing them. The previous "silent —
      // will fail at static check" path was misleading: static check runs
      // *after* the entity is supposed to exist, so the user lost the
      // entity-create attempt without ever knowing.
      const message = err instanceof Error ? err.message : "Failed to create entity. Please try again.";
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
      <input type="text" value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => { fetchEntities(); setOpen(true); setActiveIdx(-1); }}
        onBlur={(e) => { if (!containerRef.current?.contains(e.relatedTarget)) { setTimeout(() => { setOpen(false); setCreating(false); }, 150); } }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder} autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
        className={inputClass} />
      {open && loaded && totalItems > 0 && !creating && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[10rem] rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((e, i) => (
            <button key={e.name} onMouseDown={(e_) => { e_.preventDefault(); select(e.name); }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : e.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}>
              <span className="font-mono">{e.name}</span>
              <span className="ml-1.5 text-stone-400">{e.id_field}</span>
            </button>
          ))}
          {showCreateOption && (
            <button onMouseDown={(e) => { e.preventDefault(); setCreating(true); }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] border-t border-stone-100 transition-colors ${activeIdx === filtered.length ? "bg-stone-100 text-amber-700 font-medium" : "text-amber-600 hover:bg-stone-50"}`}>
              <Plus className="inline h-2.5 w-2.5 mr-0.5" />Create &ldquo;{value}&rdquo;
            </button>
          )}
        </div>
      )}
      {creating && (
        <div data-entity-popover className="absolute left-0 top-full z-30 mt-1 w-[16rem] rounded-xl border border-stone-200 bg-white shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setOpen(false); } if (e.key === "Enter") { e.preventDefault(); handleCreate(); } }}>
          <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-100 rounded-t-xl">
            <span className="text-[10px] font-medium text-amber-700">Create Entity &ldquo;{value}&rdquo;</span>
            <button onMouseDown={(e) => { e.preventDefault(); setCreating(false); }}
              className="flex h-4 w-4 items-center justify-center rounded text-amber-400 hover:text-amber-700 transition-colors">
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
            <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Describe this entity..." autoFocus autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
              className="w-full bg-transparent text-[10px] text-stone-600 placeholder:text-stone-300 focus:outline-none" />
            {createError && (
              <div className="rounded-md bg-red-50 px-2 py-1 text-[10px] text-red-600 border border-red-100">
                {createError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1.5 border-t border-stone-100">
              <button onMouseDown={(e) => { e.preventDefault(); setCreating(false); setCreateError(null); }}
                className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors">Cancel</button>
              <button onMouseDown={(e) => { e.preventDefault(); handleCreate(); }}
                disabled={submitting}
                className="rounded-full bg-stone-800 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-stone-700 transition-colors disabled:opacity-50">{submitting ? "Creating..." : "Create"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Source table combobox ----
interface SourceTableOption { name: string; kind: string; columns: { name: string; type: string }[] }
type TableStatus = "idle" | "loading" | "definition" | "catalog" | "not_found";

function SourceTableCombobox({ value, onChange, onColumnsLoaded }: {
  value: string;
  onChange: (v: string) => void;
  onColumnsLoaded: (cols: { name: string; type: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<SourceTableOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [catalogStatus, setCatalogStatus] = useState<TableStatus>("idle");
  const catalogCacheRef = useRef<Map<string, { exists: boolean; columns: { name: string; type: string }[] }>>(new Map());
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
          return { name: s.name, kind: "logger", columns: (s.columns ?? []).map((c) => ({ name: c.name, type: c.type })) };
        }),
        ...lattiks.map((d) => {
          const s = d.spec as { name: string; column_families?: { columns: { name: string; type?: string }[] }[]; derived_columns?: { name: string }[] };
          const cols = [
            ...(s.column_families ?? []).flatMap((f) => f.columns.map((c) => ({ name: c.name, type: c.type ?? "unknown" }))),
            ...(s.derived_columns ?? []).map((c) => ({ name: c.name, type: "expr" })),
          ];
          return { name: s.name, kind: "lattik", columns: cols };
        }),
      ];
      setTables(all);
      setLoaded(true);
      const match = all.find((t) => t.name === value);
      if (match) { onColumnsLoaded(match.columns); setCatalogStatus("definition"); }
    } catch { setLoaded(true); }
  };

  // Catalog fallback: debounced lookup when value doesn't match any definition
  const checkCatalog = (name: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!name.trim() || !name.includes(".")) { setCatalogStatus("idle"); return; }
    // Check cache first
    const cached = catalogCacheRef.current.get(name);
    if (cached) {
      if (cached.exists) { setCatalogStatus("catalog"); onColumnsLoaded(cached.columns); }
      else setCatalogStatus("not_found");
      return;
    }
    setCatalogStatus("loading");
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await lookupCatalogTable(name);
        catalogCacheRef.current.set(name, result);
        if (result.exists) { setCatalogStatus("catalog"); onColumnsLoaded(result.columns); }
        else setCatalogStatus("not_found");
      } catch { setCatalogStatus("not_found"); }
    }, 400);
  };

  const filtered = tables.filter((t) => !value || t.name.toLowerCase().includes(value.toLowerCase()));
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
    if (!value.trim() || !loaded) { setCatalogStatus("idle"); return; }
    if (defMatch) { onColumnsLoaded(defMatch.columns); setCatalogStatus("definition"); }
    else checkCatalog(value);
  }, [value, loaded]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((prev) => (prev + 1) % filtered.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      const idx = activeIdx < 0 ? 0 : activeIdx;
      if (idx < filtered.length) select(filtered[idx]);
    }
  };

  const badge = (() => {
    if (!value.trim() || !loaded) return null;
    switch (catalogStatus) {
      case "definition": return <span className="shrink-0 rounded bg-green-50 px-1 py-0.5 text-[9px] font-medium text-green-600 ring-1 ring-green-200/50">definition</span>;
      case "catalog": return <span className="shrink-0 rounded bg-blue-50 px-1 py-0.5 text-[9px] font-medium text-blue-600 ring-1 ring-blue-200/50">catalog</span>;
      case "loading": return <span className="shrink-0 rounded bg-stone-50 px-1 py-0.5 text-[9px] font-medium text-stone-400 ring-1 ring-stone-200/50">checking...</span>;
      case "not_found": return <span className="shrink-0 rounded bg-red-50 px-1 py-0.5 text-[9px] font-medium text-red-500 ring-1 ring-red-200/50">not found</span>;
      default: return null;
    }
  })();

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        <input type="text" value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIdx(-1); }}
          onFocus={() => { fetchTables(); setOpen(true); }}
          onBlur={(e) => { if (!containerRef.current?.contains(e.relatedTarget)) setTimeout(() => setOpen(false), 150); }}
          onKeyDown={handleKeyDown}
          placeholder="e.g. ingest.click_events" autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
          className="w-full bg-transparent text-xs font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none" />
        {badge}
      </div>
      {open && loaded && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((t, i) => (
            <button key={t.name} onMouseDown={(e) => { e.preventDefault(); select(t); }}
              className={`block w-full px-2.5 py-1 text-left text-xs transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : t.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}>
              <span className="font-mono">{t.name}</span>
              <span className="ml-1.5 text-[9px] text-stone-400">{t.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Aggregate function names for expression suggestions (from lattik-expression)
const AGGREGATE_FUNCTIONS: string[] = Array.from(KNOWN_AGGREGATES);

// ---- Expression input with autocomplete + tab-stop snippets ----

// Function parameter templates: NAME (upper-case) → placeholder args
const FN_PARAMS: Record<string, string[]> = {
  // Aggregates
  SUM: ["expr"], COUNT: [], AVG: ["expr"], MIN: ["expr"], MAX: ["expr"],
  FIRST: ["expr"], LAST: ["expr"], ANY_VALUE: ["expr"],
  COUNT_DISTINCT: ["expr"], COUNT_IF: ["condition"],
  SUM_IF: ["expr", "condition"], AVG_IF: ["expr", "condition"],
  COLLECT_LIST: ["expr"], COLLECT_SET: ["expr"],
  STDDEV: ["expr"], VARIANCE: ["expr"],
  PERCENTILE: ["col", "percentile"], PERCENTILE_APPROX: ["col", "accuracy"],
  APPROX_COUNT_DISTINCT: ["expr"],
  // Common scalar functions
  UPPER: ["str"], LOWER: ["str"], TRIM: ["str"], LENGTH: ["str"],
  COALESCE: ["expr1", "expr2"], ABS: ["num"], ROUND: ["num", "decimals"],
  SUBSTR: ["str", "start", "length"], CONCAT: ["str1", "str2"],
  CAST: ["expr"], IF: ["condition", "then", "else"],
};

const SCALAR_FUNCTIONS = ["UPPER", "LOWER", "TRIM", "COALESCE", "ABS", "ROUND", "SUBSTR", "CONCAT", "LENGTH", "CAST", "IF"];

// Tab stop: [start, end] character ranges in the input value
type TabStop = [number, number];

// Extract the identifier token at a given cursor position within a string.
// Returns { token, start, end } where start/end are character offsets.
function tokenAtCursor(text: string, cursor: number): { token: string; start: number; end: number } {
  const before = text.slice(0, cursor);
  const match = before.match(/([a-z_][a-z0-9_]*)$/i);
  if (!match) return { token: "", start: cursor, end: cursor };
  const start = cursor - match[1].length;
  return { token: match[1].toLowerCase(), start, end: cursor };
}

function ExpressionInput({ value, onChange, label, placeholder, sourceCols }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  sourceCols: { name: string; type: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [tabStops, setTabStops] = useState<TabStop[]>([]);
  const [tabIdx, setTabIdx] = useState(-1);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Extract the token at cursor position
  const { token: cursorToken, start: tokenStart, end: tokenEnd } = tokenAtCursor(value, cursor);

  // Build suggestions: functions first, then columns (match case-insensitively)
  const allFunctions = [...AGGREGATE_FUNCTIONS, ...SCALAR_FUNCTIONS];
  const tokenUpper = cursorToken.toUpperCase();
  const suggestions: { label: string; detail: string; fnName?: string; kind: "fn" | "col" }[] = [];
  if (cursorToken) {
    for (const fn of allFunctions) {
      if (fn.startsWith(tokenUpper)) {
        const params = FN_PARAMS[fn];
        const display = params ? `${fn}(${params.join(", ")})` : `${fn}()`;
        const detail = AGGREGATE_FUNCTIONS.includes(fn) ? "aggregate" : "function";
        suggestions.push({ label: display, detail, fnName: fn, kind: "fn" });
      }
    }
    for (const col of sourceCols) {
      if (col.name.toLowerCase().startsWith(cursorToken) && col.name.toLowerCase() !== cursorToken) {
        suggestions.push({ label: col.name, detail: col.type, kind: "col" });
      }
    }
  }

  const showDropdown = open && suggestions.length > 0;

  const applySuggestion = (s: typeof suggestions[number]) => {
    const before = value.slice(0, tokenStart);
    const after = value.slice(tokenEnd);
    if (s.kind === "fn" && s.fnName) {
      const params = FN_PARAMS[s.fnName] ?? [];
      if (params.length === 0) {
        const inserted = s.fnName + "()";
        const text = before + inserted + after;
        onChange(text);
        setTabStops([]);
        setTabIdx(-1);
        const cursorPos = before.length + inserted.length - 1; // inside parens
        setTimeout(() => inputRef.current?.setSelectionRange(cursorPos, cursorPos), 0);
      } else {
        const argsStr = params.join(", ");
        const inserted = s.fnName + "(" + argsStr + ")";
        const text = before + inserted + after;
        onChange(text);

        // Compute tab stop ranges relative to insertion point
        const stops: TabStop[] = [];
        let offset = before.length + s.fnName.length + 1; // after "("
        for (let i = 0; i < params.length; i++) {
          stops.push([offset, offset + params[i].length]);
          offset += params[i].length + 2; // ", "
        }
        setTabStops(stops);
        setTabIdx(0);
        setTimeout(() => inputRef.current?.setSelectionRange(stops[0][0], stops[0][1]), 0);
      }
    } else {
      const text = before + s.label + after;
      onChange(text);
      setTabStops([]);
      setTabIdx(-1);
      const cursorPos = before.length + s.label.length;
      setTimeout(() => inputRef.current?.setSelectionRange(cursorPos, cursorPos), 0);
    }
    setOpen(false);
    setActiveIdx(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Tab-stop navigation — only intercept when there's a next stop to jump to
    if (e.key === "Tab" && tabStops.length > 0 && tabIdx >= 0) {
      const nextIdx = tabIdx + 1;
      if (nextIdx < tabStops.length) {
        e.preventDefault();
        e.stopPropagation();
        setTabIdx(nextIdx);
        setTimeout(() => inputRef.current?.setSelectionRange(tabStops[nextIdx][0], tabStops[nextIdx][1]), 0);
        return;
      }
      // Last tab stop — clear state and let Tab fall through to next form field
      setTabStops([]);
      setTabIdx(-1);
      return;
    }

    // Dropdown navigation — only arrow keys, Enter, and Escape; never Tab
    if (showDropdown) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((prev) => (prev + 1) % suggestions.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1)); }
      else if (e.key === "Enter") {
        const idx = activeIdx >= 0 ? activeIdx : 0;
        if (idx < suggestions.length) {
          e.preventDefault(); e.stopPropagation();
          applySuggestion(suggestions[idx]);
        }
      } else if (e.key === "Escape") { setOpen(false); }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    const newCursor = e.target.selectionStart ?? newVal.length;
    onChange(newVal);
    setCursor(newCursor);
    setOpen(true);
    setActiveIdx(0);
    // Recalculate tab stops after user edits a placeholder
    if (tabStops.length > 0 && tabIdx >= 0) {
      const oldStop = tabStops[tabIdx];
      const oldLen = oldStop[1] - oldStop[0];
      const newLen = newCursor - oldStop[0];
      const delta = newLen - oldLen;
      setTabStops((prev) => prev.map((s, i) => {
        if (i < tabIdx) return s;
        if (i === tabIdx) return [s[0], s[0] + newLen];
        return [s[0] + delta, s[1] + delta];
      }));
    }
  };

  // Parse validation
  const parseResult = value.trim() ? parse(value.trim()) : null;
  const hasError = parseResult !== null && parseResult.errors.length > 0;
  const isValid = parseResult !== null && parseResult.errors.length === 0;

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1">
      <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">{label}</label>
      <div className="flex items-center gap-1.5">
        <input ref={inputRef} type="text" value={value}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onBlur={(e) => { if (!containerRef.current?.contains(e.relatedTarget)) setTimeout(() => setOpen(false), 150); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full bg-transparent text-xs font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none" />
        {isValid && <span className="shrink-0 rounded bg-green-50 px-1 py-0.5 text-[9px] font-medium text-green-600 ring-1 ring-green-200/50">valid</span>}
      </div>
      {hasError && <p className="text-[10px] text-red-500">{parseResult.errors[0].message}</p>}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button key={s.label} onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
              className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-xs transition-colors ${i === activeIdx ? "bg-stone-100" : "hover:bg-stone-50"}`}>
              <span className={`font-mono ${s.kind === "fn" ? "text-amber-700" : "text-blue-700"}`}>{s.label}</span>
              <span className="text-[9px] text-stone-400">{s.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Dimension combobox with inline create ----
//
// Mirrors EntityCombobox but operates on dimensions. Used inside the Logger
// Table column popup so users can pick or create a dimension without leaving
// the table form. The create popover auto-fills source_table from the parent
// table name and source_column / data_type from the column being added, so
// the inline create only requires the user to confirm the entity + a short
// description.
interface DimensionOption { name: string; entity: string; source_table: string; source_column: string; data_type: string; description?: string }

function DimensionCombobox({
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
    } catch { setLoaded(true); }
  };

  const filtered = dimensions.filter((d) => !value || d.name.includes(value.toLowerCase()));
  const exactMatch = dimensions.some((d) => d.name === value);
  const showCreateOption = !!value.trim() && !exactMatch && loaded && !dimInvalid;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  const select = (name: string) => { onChange(name); setOpen(false); setActiveIdx(0); };

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
    if (e.key === "Escape") { setOpen(false); setCreating(false); return; }
    if (creating) return;
    if (!open || totalItems === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((prev) => (prev + 1) % totalItems); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((prev) => (prev <= 0 ? totalItems - 1 : prev - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      const idx = activeIdx < 0 ? 0 : activeIdx;
      if (idx < filtered.length) select(filtered[idx].name);
      else if (showCreateOption) openCreate();
    }
  };

  const handleCreate = async () => {
    const name = value.trim();
    if (!name || submitting) return;
    if (!SNAKE_CASE_RE.test(name)) { setCreateError("Name must be snake_case"); return; }
    if (!newEntity.trim()) { setCreateError("Entity is required"); return; }
    if (!newSourceTable.trim()) { setCreateError("Source table is required"); return; }
    if (!newSourceColumn.trim()) { setCreateError("Source column is required"); return; }
    if (!newDataType.trim()) { setCreateError("Data type is required"); return; }
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
      const message = err instanceof Error ? err.message : "Failed to create dimension. Please try again.";
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
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => { fetchDimensions(); setOpen(true); setActiveIdx(-1); }}
        onBlur={(e) => { if (!containerRef.current?.contains(e.relatedTarget)) { setTimeout(() => { setOpen(false); setCreating(false); }, 150); } }}
        onKeyDown={handleKeyDown}
        placeholder="Bind to dimension if applicable"
        autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
        className={`flex-1 min-w-0 w-full bg-transparent text-xs text-stone-600 placeholder:text-stone-300 focus:outline-none ${dimInvalid ? "text-red-500" : ""}`}
      />
      {dimInvalid && <span className="text-[10px] text-red-500">Must be snake_case</span>}
      {open && loaded && totalItems > 0 && !creating && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[14rem] rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-44 overflow-y-auto">
          {filtered.map((d, i) => (
            <button
              key={d.name}
              onMouseDown={(e_) => { e_.preventDefault(); select(d.name); }}
              className={`block w-full px-2.5 py-1 text-left text-[10px] transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : d.name === value ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono">{d.name}</span>
                <span className="text-stone-400">{d.entity}</span>
              </div>
              <div className="text-[9px] text-stone-400 truncate">{d.source_table}.{d.source_column}</div>
            </button>
          ))}
          {showCreateOption && (
            <button
              onMouseDown={(e) => { e.preventDefault(); openCreate(); }}
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
          onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setOpen(false); } }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-100 rounded-t-xl">
            <span className="text-[10px] font-medium text-amber-700">Create Dimension &ldquo;{value}&rdquo;</span>
            <button
              onMouseDown={(e) => { e.preventDefault(); setCreating(false); }}
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
                autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
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
                autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
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
              autoFocus autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
              className="w-full bg-transparent text-[10px] text-stone-600 placeholder:text-stone-300 focus:outline-none border-t border-stone-100 pt-2"
            />
            {createError && (
              <div className="rounded-md bg-red-50 px-2 py-1 text-[10px] text-red-600 border border-red-100">
                {createError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1.5 border-t border-stone-100">
              <button
                onMouseDown={(e) => { e.preventDefault(); setCreating(false); setCreateError(null); }}
                className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onMouseDown={(e) => { e.preventDefault(); handleCreate(); }}
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

const IMPLICIT_TOP = [
  { name: "event_id", type: "string", description: "Unique event identifier for deduplication" },
  { name: "event_timestamp", type: "timestamp", description: "When the event occurred" },
];
const IMPLICIT_BOTTOM = [
  { name: "ds", type: "string", description: "Date partition key" },
  { name: "hour", type: "string", description: "Hour partition key" },
];

function ImplicitRow({ name, type, description, highlighted, onHover, onLeave }: { name: string; type: string; description?: string; highlighted?: boolean; onHover?: () => void; onLeave?: () => void }) {
  return (
    <tr className={`border-b border-stone-100 transition-colors ${highlighted ? "bg-amber-50" : "bg-stone-50/50"}`}
      onMouseEnter={onHover} onMouseLeave={onLeave}>
      <td className={`px-2.5 py-1.5 font-mono text-xs ${highlighted ? "text-amber-700" : "text-stone-400"}`}>{name}</td>
      <td className={`px-2.5 py-1.5 text-xs uppercase ${highlighted ? "text-amber-600" : "text-stone-400"}`}>{type}</td>
      <td className="px-2.5 py-1.5 text-[10px] text-stone-400/70">{description}</td>
      <td className="px-2.5 py-1.5 w-8" title="System column — cannot be modified">
        <Lock className="h-3 w-3 text-stone-300" />
      </td>
    </tr>
  );
}

// ---- Mock data generator ----
const MOCK_TIMESTAMPS = ["2026-04-05T10:23:01", "2026-04-04T14:07:45", "2026-04-03T08:52:19"];
const MOCK_FLOATS = ["42.17", "8.93", "71.56"];
const MOCK_DS = ["2026-04-05", "2026-04-05", "2026-04-05"];
const MOCK_HOURS = ["10", "10", "10"];

function mockValue(type: string, i: number, colName?: string): string {
  if (colName === "ds") return MOCK_DS[i % MOCK_DS.length];
  if (colName === "hour") return MOCK_HOURS[i % MOCK_HOURS.length];
  switch (type) {
    case "int32": case "int64": return String(1000 + i * 7);
    case "float": case "double": return MOCK_FLOATS[i % MOCK_FLOATS.length];
    case "boolean": return i % 2 === 0 ? "true" : "false";
    case "timestamp": return MOCK_TIMESTAMPS[i % MOCK_TIMESTAMPS.length];
    case "date": return MOCK_DS[i % MOCK_DS.length];
    case "json": return "{}";
    default: return `value_${i + 1}`;
  }
}

// ---- Status badge styles ----
const statusStyles: Record<string, { bg: string; text: string; dot: string }> = {
  draft: { bg: "bg-amber-100/50", text: "text-amber-700", dot: "bg-amber-400" },
  reviewing: { bg: "bg-blue-100/50", text: "text-blue-700", dot: "bg-blue-400" },
  "checks-passed": { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-400" },
  "checks-failed": { bg: "bg-red-100/50", text: "text-red-700", dot: "bg-red-400" },
  "pr-submitted": { bg: "bg-purple-100/50", text: "text-purple-700", dot: "bg-purple-400" },
  merged: { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-500" },
};

// ============================================================
// Registry
// ============================================================

export const { registry, handlers } = defineRegistry(catalog, {
  components: {
    // --- Layout ---
    Section: ({ props, children }) => (
      <div className="flex flex-col gap-3">
        {props.title && (
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            {props.title}
          </h3>
        )}
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    ),

    // Composite forms render their own titles — suppress agent-generated headings
    Heading: () => null,

    // --- Form fields ---
    TextInput: ({ props }) => {
      const [value, setValue] = useField(props.field);
      const v = (value as string) ?? props.defaultValue ?? "";

      if (props.variant === "title") {
        return (
          <input type="text" value={v} onChange={(e) => setValue(e.target.value)}
            placeholder={props.placeholder}
            className="w-full bg-transparent text-base font-semibold text-stone-800 placeholder:text-stone-400 focus:outline-none" />
        );
      }
      if (props.variant === "subtitle") {
        return (
          <input type="text" value={v} onChange={(e) => setValue(e.target.value)}
            placeholder={props.placeholder}
            className="w-full bg-transparent text-sm text-stone-600 placeholder:text-stone-400 focus:outline-none" />
        );
      }
      return (
        <div className="flex flex-col gap-1">
          {props.label && (
            <label className="text-xs font-medium text-stone-600">
              {props.label}
              {props.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
          )}
          {props.multiline ? (
            <textarea value={v} onChange={(e) => setValue(e.target.value)}
              placeholder={props.placeholder} rows={3} className={`${inputCls} resize-none`} />
          ) : (
            <input type="text" value={v} onChange={(e) => setValue(e.target.value)}
              placeholder={props.placeholder} className={inputCls} />
          )}
        </div>
      );
    },

    Select: ({ props }) => {
      const [value, setValue] = useField(props.field);
      const v = (value as string) ?? props.defaultValue ?? "";
      return (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-stone-600">
            {props.label}
            {props.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          <select value={v} onChange={(e) => setValue(e.target.value)} className={inputCls}>
            <option value="">Select...</option>
            {props.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    },

    Checkbox: ({ props }) => {
      const [value, setValue] = useField(props.field);
      const checked = (value as boolean) ?? props.defaultValue ?? false;
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={checked} onChange={(e) => setValue(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-stone-300 text-amber-600 focus:ring-amber-500/30" />
          <span className="text-xs text-stone-700">{props.label}</span>
        </label>
      );
    },

    // --- Data display ---
    DataTable: ({ props }) => {
      if (!props.columns.length) return null;
      return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          {props.title && (
            <div className="border-b border-stone-200 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">{props.title}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50">
                  {props.columns.map((c) => (
                    <th key={c.key} className="px-2.5 py-1 text-left font-semibold text-stone-600">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row, i) => (
                  <tr key={i} className="border-b border-stone-100 last:border-b-0">
                    {props.columns.map((c) => (
                      <td key={c.key} className="px-2.5 py-1 text-stone-700">{String(row[c.key] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    },

    MockedTablePreview: ({ props }) => {
      const cols = props.columns;
      if (!cols.length) return null;
      const count = Math.min(Math.max(props.rowCount ?? 3, 0), 50);
      const rows = Array.from({ length: count }, (_, i) =>
        Object.fromEntries(cols.map((c) => [c.name, mockValue(c.type, i, c.name)]))
      );
      return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          {props.title && (
            <div className="border-b border-stone-200 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">{props.title}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50">
                  {cols.map((c) => (
                    <th key={c.name} className="px-2.5 py-1 text-left font-semibold text-stone-600">
                      <div>{c.name}</div>
                      <div className="font-normal text-stone-400 text-[9px]">{c.type}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-stone-100 last:border-b-0">
                    {cols.map((c) => (
                      <td key={c.name} className="px-2.5 py-1 font-mono text-stone-600 text-[10px]">{String(row[c.name])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    },

    // --- Domain-specific ---
    ColumnList: ({ props }) => {
      const [value, setValue] = useField(props.field);
      const columns = (value as UserColumn[]) ?? [];
      const types = props.typeOptions ?? TYPE_OPTIONS;

      const update = (i: number, patch: Partial<UserColumn>) =>
        setValue(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      const add = () => setValue([...columns, { _key: genKey("cl"), name: "", type: "string" }]);
      const remove = (i: number) => setValue(columns.filter((_, j) => j !== i));

      return (
        <div className="flex flex-col gap-2">
          {props.label && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">{props.label}</span>
              <button onClick={add} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-50 transition-colors">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
          )}
          {columns.map((col, i) => (
            <div key={col._key ?? `idx_${i}`} className="flex items-start gap-1.5 rounded-md border border-stone-200 bg-white px-2 py-1.5">
              <input type="text" value={col.name} onChange={(e) => update(i, { name: e.target.value })}
                placeholder="column_name" maxLength={60}
                className="flex-1 min-w-0 rounded border-0 bg-transparent px-1 py-0.5 text-xs font-mono text-stone-800 placeholder:text-stone-400 focus:outline-none" />
              <select value={col.type} onChange={(e) => update(i, { type: e.target.value })}
                className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-stone-600 focus:outline-none">
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={() => remove(i)} className="flex h-5 w-5 items-center justify-center rounded text-stone-400 hover:text-red-500 transition-colors">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {columns.length === 0 && (
            <button onClick={add} className="rounded-md border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500 hover:border-amber-500 hover:text-amber-700 hover:bg-amber-50/50 transition-colors">
              Add first column...
            </button>
          )}
        </div>
      );
    },

    ReviewCard: ({ props }) => {
      const [decision, setDecision] = useField(`review_${props.suggestionId}`);
      const d = decision as "accepted" | "denied" | undefined;
      const bgColor = d === "accepted" ? "bg-green-50/50" : d === "denied" ? "bg-red-50/30" : "bg-white";

      return (
        <div className={`rounded-lg border border-stone-200 ${bgColor} px-3 py-2 transition-colors`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="text-xs font-semibold text-stone-800">{props.title}</div>
              <div className="mt-0.5 text-[11px] text-stone-600">{props.description}</div>
            </div>
            {!d && (
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setDecision("accepted")}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-green-300/50 text-green-600 hover:bg-green-100/50 transition-colors" title="Accept">
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setDecision("denied")}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-red-300/50 text-red-500 hover:bg-red-100/50 transition-colors" title="Deny">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {d && (
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${d === "accepted" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                {d}
              </span>
            )}
          </div>
        </div>
      );
    },

    StatusBadge: ({ props }) => {
      const style = statusStyles[props.status] ?? statusStyles.draft;
      return (
        <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${style.bg}`}>
          <div className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          <span className={`text-[11px] font-medium ${style.text}`}>{props.label ?? props.status}</span>
          {props.step && <span className="text-[10px] text-stone-500">{props.step}</span>}
        </div>
      );
    },

    // --- Composite forms ---
    LoggerTableForm: () => {
      const { sendChatMessage } = useCanvasActions();
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      const retention = (store.get("/retention") as string) ?? "30d";
      const dedupWindow = (store.get("/dedup_window") as string) ?? "1h";
      const columns = (store.get("/user_columns") as UserColumn[]) ?? [];

      const [hoveredCol, setHoveredCol] = useState<string | null>(null);
      // Each preview header <th> registers itself here so hovering a row in
      // the Columns table below can scroll the matching preview column into
      // view when the preview table is wider than the viewport.
      const previewHeadRefs = useRef<Map<string, HTMLTableCellElement | null>>(new Map());
      useEffect(() => {
        if (!hoveredCol) return;
        const el = previewHeadRefs.current.get(hoveredCol);
        el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }, [hoveredCol]);
      const [showAddCol, setShowAddCol] = useState(false);
      const [newColName, setNewColName] = useState("");
      const [newColType, setNewColType] = useState("");
      const [newColDesc, setNewColDesc] = useState("");
      const [newColDim, setNewColDim] = useState("");
      const [newColClassification, setNewColClassification] = useState<Classification | undefined>(undefined);
      const [newColTags, setNewColTags] = useState<string[]>([]);
      const [newTagDraft, setNewTagDraft] = useState("");
      const [editIdx, setEditIdx] = useState<number | null>(null);
      const [editName, setEditName] = useState("");
      const [editType, setEditType] = useState("string");
      const [editDesc, setEditDesc] = useState("");
      const [editDim, setEditDim] = useState("");
      const [editClassification, setEditClassification] = useState<Classification | undefined>(undefined);
      const [editTags, setEditTags] = useState<string[]>([]);
      const [editTagDraft, setEditTagDraft] = useState("");

      const updateCol = (i: number, patch: Partial<UserColumn>) =>
        store.set("/user_columns", columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      const addCol = () => {
        if (!newColName.trim()) return;
        const dim = newColDim.trim() || undefined;
        if (dim && !SNAKE_CASE_RE.test(dim)) return;
        const tags = newColTags.length > 0 ? newColTags : undefined;
        store.set("/user_columns", [...columns, { _key: genKey("col"), name: newColName.trim(), type: newColType, description: newColDesc.trim() || undefined, dimension: dim, classification: newColClassification, tags }]);
        setNewColName(""); setNewColType(""); setNewColDesc(""); setNewColDim(""); setNewColClassification(undefined); setNewColTags([]); setNewTagDraft("");
        setShowAddCol(false);
      };
      const removeCol = (i: number) =>
        store.set("/user_columns", columns.filter((_, j) => j !== i));
      const startEdit = (i: number) => {
        setEditIdx(i);
        setEditName(columns[i].name);
        setEditType(columns[i].type);
        setEditDesc(columns[i].description ?? "");
        setEditDim(columns[i].dimension ?? "");
        setEditClassification(columns[i].classification);
        setEditTags(columns[i].tags ?? []);
        setEditTagDraft("");
      };
      const saveEdit = () => {
        if (editIdx === null || !editName.trim()) return;
        const dim = editDim.trim() || undefined;
        if (dim && !SNAKE_CASE_RE.test(dim)) return;
        const tags = editTags.length > 0 ? editTags : undefined;
        updateCol(editIdx, { name: editName.trim(), type: editType, description: editDesc.trim() || undefined, dimension: dim, classification: editClassification, tags });
        setEditIdx(null);
      };
      const cancelEdit = () => setEditIdx(null);
      const closePopup = () => { setShowAddCol(false); cancelEdit(); setNewColName(""); setNewColType(""); setNewColDesc(""); setNewColDim(""); setNewColClassification(undefined); setNewColTags([]); setNewTagDraft(""); setEditTagDraft(""); };

      const allPreviewCols = [...IMPLICIT_TOP, ...columns.filter((c) => c.name), ...IMPLICIT_BOTTOM];

      return (
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <Table2 className="h-4 w-4 text-stone-400" />Logger Table
          </h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="schema.table_name"
              className="w-full border-b border-stone-200 bg-transparent pb-1 text-base font-semibold text-stone-800 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none transition-colors" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what events this table captures..."
              className="w-full bg-transparent text-sm text-stone-600 placeholder:text-stone-400 focus:outline-none" />
          </div>

          {/* Retention & dedup */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-stone-400">Retention:</span>
              <input type="text" value={retention} onChange={(e) => store.set("/retention", e.target.value)}
                placeholder="30d"
                className="w-12 bg-transparent text-xs font-medium text-stone-800 placeholder:text-stone-400 focus:outline-none border-b border-transparent focus:border-amber-500 transition-colors" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-stone-400">Dedup:</span>
              <input type="text" value={dedupWindow} onChange={(e) => store.set("/dedup_window", e.target.value)}
                placeholder="1h"
                className="w-12 bg-transparent text-xs font-medium text-stone-800 placeholder:text-stone-400 focus:outline-none border-b border-transparent focus:border-amber-500 transition-colors" />
            </div>
          </div>

          {/* Preview */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Preview</span>
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50">
                      {allPreviewCols.map((c) => (
                        <th
                          key={c.name}
                          ref={(el) => { previewHeadRefs.current.set(c.name, el); }}
                          className={`px-2.5 py-1.5 text-left font-semibold whitespace-nowrap transition-colors ${hoveredCol === c.name ? "bg-amber-100 text-amber-800" : "text-stone-600"}`}
                        >
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 3 }, (_, i) => (
                      <tr key={i} className="border-b border-stone-100 last:border-b-0">
                        {allPreviewCols.map((c) => (
                          <td key={c.name} className={`px-2.5 py-1 font-mono text-[10px] whitespace-nowrap transition-colors ${hoveredCol === c.name ? "bg-amber-50 text-amber-700" : "text-stone-500"}`}>
                            {mockValue(c.type, i, c.name)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Columns */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Columns</span>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white">
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-stone-50">
                    <tr className="border-b border-stone-200">
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Column</th>
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Type</th>
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Description</th>
                      <th className="px-2.5 py-1.5 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {/* System columns (top) */}
                    {IMPLICIT_TOP.map((c) => <ImplicitRow key={c.name} name={c.name} type={c.type} description={c.description} highlighted={hoveredCol === c.name} onHover={() => setHoveredCol(c.name)} onLeave={() => setHoveredCol(null)} />)}

                  {/* Separator: user columns section */}
                  <tr>
                    <td colSpan={4} className="px-2.5 pt-2.5 pb-1">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Custom columns</span>
                    </td>
                  </tr>

                  {/* User-defined columns */}
                  {columns.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-2.5 py-2 text-center text-[11px] text-stone-400 italic">
                        No custom columns yet
                      </td>
                    </tr>
                  )}
                  {columns.map((col, i) => (
                    <tr key={col._key} className={`border-b border-stone-100 group transition-colors cursor-pointer ${hoveredCol === col.name && col.name ? "bg-amber-50" : ""}`}
                      onMouseEnter={() => col.name && setHoveredCol(col.name)} onMouseLeave={() => setHoveredCol(null)}
                      onClick={() => startEdit(i)}>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-stone-800">{col.name || <span className="text-stone-400 italic">unnamed</span>}</span>
                          {CLASSIFICATION_CATEGORIES.filter((cat) => col.classification?.[cat.key]).map((cat) => (
                            <span key={cat.key} className={`rounded px-1 py-0.5 text-[9px] font-medium ${cat.badgeCls}`}>{cat.label}</span>
                          ))}
                          {col.dimension && <span className="rounded bg-blue-100 px-1 py-0.5 text-[9px] font-medium text-blue-600">{col.dimension}</span>}
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-xs text-stone-600 uppercase">{col.type}</td>
                      <td className="px-2.5 py-1.5 text-[10px] text-stone-400">{col.description}</td>
                      <td className="px-1 py-0.5 w-8">
                        <button onClick={(e) => { e.stopPropagation(); removeCol(i); }}
                          className="flex h-5 w-5 items-center justify-center rounded text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}

                  {/* Add column button */}
                  <tr>
                    <td colSpan={4} className="px-2.5 py-1.5">
                      <button onClick={() => setShowAddCol(true)}
                        className="flex items-center gap-1.5 rounded-md border border-dashed border-stone-300 px-2.5 py-1.5 text-[11px] text-stone-500 hover:border-amber-500 hover:text-amber-700 hover:bg-amber-50/50 transition-colors w-full justify-center">
                        <Plus className="h-3 w-3" /> Add column
                      </button>
                    </td>
                  </tr>

                  {/* Separator: system partition columns */}
                  <tr>
                    <td colSpan={4} className="px-2.5 pt-2.5 pb-1 border-t border-stone-200">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Partition columns</span>
                    </td>
                  </tr>
                  {IMPLICIT_BOTTOM.map((c) => <ImplicitRow key={c.name} name={c.name} type={c.type} description={c.description} highlighted={hoveredCol === c.name} onHover={() => setHoveredCol(c.name)} onLeave={() => setHoveredCol(null)} />)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Review table button — sits below the scrollable columns table */}
          <button
            onClick={() => sendChatMessage("Review table")}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            Review Table
          </button>

          {/* Column popup */}
          {(showAddCol || editIdx !== null) && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-[1px] rounded-lg" onClick={closePopup}>
              <div className="w-[22rem] rounded-xl border border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === "Escape") closePopup(); if (e.key === "Enter") { e.preventDefault(); editIdx !== null ? saveEdit() : addCol(); } }}>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2 bg-amber-50 border-b border-amber-100 rounded-t-xl">
                  <span className="text-[11px] font-medium text-amber-700">{editIdx !== null ? "Edit Column" : "Add Column"}</span>
                  <button onClick={closePopup} className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-amber-700 transition-colors">
                    <X className="h-3 w-3" />
                  </button>
                </div>

                {/* Body */}
                <div className="flex flex-col gap-3 px-4 py-4">
                  {/* Name */}
                  <input type="text" value={editIdx !== null ? editName : newColName}
                    onChange={(e) => editIdx !== null ? setEditName(e.target.value) : setNewColName(e.target.value)}
                    placeholder="new_column_name" autoFocus maxLength={60}
                    className="w-full bg-transparent text-sm font-semibold font-mono text-stone-800 placeholder:text-stone-300 placeholder:font-sans placeholder:font-normal focus:outline-none" />

                  {/* Classification pills — each flag is an independent compliance concern */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {CLASSIFICATION_CATEGORIES.map((cat) => {
                      const active = !!(editIdx !== null ? editClassification?.[cat.key] : newColClassification?.[cat.key]);
                      const onClick = () => {
                        if (editIdx !== null) setEditClassification((c) => toggleClassification(c, cat.key));
                        else setNewColClassification((c) => toggleClassification(c, cat.key));
                      };
                      return (
                        <button key={cat.key} type="button" onClick={onClick}
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${active ? cat.pillActiveCls : "bg-stone-100 text-stone-400 hover:bg-stone-200 hover:text-stone-600"}`}>
                          {cat.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Tags — freeform non-compliance labels (e.g. "high-cardinality", "deprecated"). */}
                  {(() => {
                    const tags = editIdx !== null ? editTags : newColTags;
                    const setTags = editIdx !== null ? setEditTags : setNewColTags;
                    const draft = editIdx !== null ? editTagDraft : newTagDraft;
                    const setDraft = editIdx !== null ? setEditTagDraft : setNewTagDraft;
                    const commitDraft = () => {
                      const t = draft.trim();
                      if (!t) return;
                      if (tags.includes(t)) { setDraft(""); return; }
                      setTags([...tags, t]);
                      setDraft("");
                    };
                    const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));
                    return (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {tags.map((t) => (
                          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                            {t}
                            <button type="button" onClick={() => removeTag(t)} className="text-stone-400 hover:text-stone-700 transition-colors">
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                        <input
                          type="text"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault(); e.stopPropagation(); commitDraft();
                            } else if (e.key === "Backspace" && !draft && tags.length > 0) {
                              e.preventDefault(); setTags(tags.slice(0, -1));
                            }
                          }}
                          onBlur={commitDraft}
                          placeholder={tags.length === 0 ? "Add tag" : ""}
                          className="flex-1 min-w-[4rem] bg-transparent text-[10px] text-stone-600 placeholder:text-stone-300 focus:outline-none"
                        />
                      </div>
                    );
                  })()}

                  {/* Type */}
                  <div className="relative">
                    <TypeCombobox value={editIdx !== null ? editType : newColType}
                      onChange={(v) => editIdx !== null ? setEditType(v) : setNewColType(v)} />
                  </div>

                  {/* Description */}
                  <input type="text" value={editIdx !== null ? editDesc : newColDesc}
                    onChange={(e) => editIdx !== null ? setEditDesc(e.target.value) : setNewColDesc(e.target.value)}
                    placeholder="Describe the column"
                    className="w-full bg-transparent text-xs text-stone-500 placeholder:text-stone-300 focus:outline-none" />

                  {/* Dimension (with inline create) */}
                  <div className="flex flex-col gap-1">
                    <DimensionCombobox
                      value={editIdx !== null ? editDim : newColDim}
                      onChange={(v) => editIdx !== null ? setEditDim(v) : setNewColDim(v)}
                      parentTableName={name}
                      columnName={editIdx !== null ? editName : newColName}
                      columnType={editIdx !== null ? editType : newColType}
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-100">
                    <button onClick={closePopup}
                      className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors">
                      Cancel
                    </button>
                    <button onClick={() => editIdx !== null ? saveEdit() : addCol()}
                      className="rounded-full bg-stone-800 px-3 py-1 text-[11px] font-medium text-white hover:bg-stone-700 transition-colors">
                      {editIdx !== null ? "Save" : "Add"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    },

    EntityForm: () => {
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      const idField = (store.get("/id_field") as string) ?? "";
      const idType = (store.get("/id_type") as string) ?? "string";

      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-amber-900">Define a New Entity</h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="entity_name" className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what this entity represents..."
              className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">ID Field</label>
              <input type="text" value={idField} onChange={(e) => store.set("/id_field", e.target.value)}
                placeholder="e.g. user_id" className={inputCls} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">ID Type</label>
              <select value={idType} onChange={(e) => store.set("/id_type", e.target.value)} className={inputCls}>
                <option value="string">string</option>
                <option value="int64">int64</option>
              </select>
            </div>
          </div>
        </div>
      );
    },

    DimensionForm: () => {
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      const entity = (store.get("/entity") as string) ?? "";
      const sourceTable = (store.get("/source_table") as string) ?? "";
      const sourceColumn = (store.get("/source_column") as string) ?? "";
      const dataType = (store.get("/data_type") as string) ?? "string";

      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-amber-900">Define a New Dimension</h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="entity_dimension_name" className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what this dimension represents..."
              className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-amber-800">Entity</label>
            <EntityCombobox
              variant="default"
              value={entity}
              onChange={(v) => store.set("/entity", v)}
              pkColumn=""
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">Source Table</label>
              <input type="text" value={sourceTable} onChange={(e) => store.set("/source_table", e.target.value)}
                placeholder="e.g. ingest.click_events" className={inputCls} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">Source Column</label>
              <input type="text" value={sourceColumn} onChange={(e) => store.set("/source_column", e.target.value)}
                placeholder="e.g. country_code" className={inputCls} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-amber-800">Data Type</label>
            <select value={dataType} onChange={(e) => store.set("/data_type", e.target.value)} className={inputCls}>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
      );
    },

    MetricForm: () => {
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      interface Calc { _key: string; expression: string; source_table: string }
      const calcs = (store.get("/calculations") as Calc[]) ?? [];

      const updateCalc = (i: number, patch: Partial<Calc>) =>
        store.set("/calculations", calcs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      const addCalc = () =>
        store.set("/calculations", [...calcs, { _key: genKey("calc"), expression: "", source_table: "" }]);
      const removeCalc = (i: number) =>
        store.set("/calculations", calcs.filter((_, j) => j !== i));

      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-amber-900">Define a New Metric</h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="metric_name" className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what this metric measures..."
              className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">Calculations</span>
              <button onClick={addCalc} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {calcs.map((calc, i) => (
              <div key={calc._key} className="flex flex-col gap-2 rounded-lg border border-amber-200/30 bg-white/60 p-2.5">
                <div className="flex items-start gap-1.5">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <input type="text" value={calc.expression} onChange={(e) => updateCalc(i, { expression: e.target.value })}
                      placeholder="e.g. count_distinct(user_id)" className={`w-full ${inputCls} font-mono`} />
                    <input type="text" value={calc.source_table} onChange={(e) => updateCalc(i, { source_table: e.target.value })}
                      placeholder="Source table" className={`w-full ${inputCls}`} />
                  </div>
                  <button onClick={() => removeCalc(i)}
                    className="mt-1 flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
            {calcs.length === 0 && (
              <button onClick={addCalc}
                className="rounded-md border border-dashed border-amber-300/50 px-3 py-2 text-xs text-amber-600/60 hover:bg-amber-50/50 transition-colors">
                Add first calculation...
              </button>
            )}
          </div>
        </div>
      );
    },

    LattikTableForm: () => {
      const { sendChatMessage } = useCanvasActions();
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      const retention = (store.get("/retention") as string) ?? "30d";

      interface PK { _key: string; column: string; entity: string }
      interface FCol { _key: string; name: string; strategy: string; type?: string; agg?: string; expr?: string; max_length?: number; granularity?: string; window?: number; description?: string }
      interface KM { _key: string; pk_column: string; source_column: string }
      interface CF { _key: string; name: string; source: string; key_mapping?: KM[]; columns: FCol[] }
      interface DC { _key: string; name: string; expr: string; description?: string }

      const pks = (store.get("/primary_key") as PK[]) ?? [];
      const families = (store.get("/column_families") as CF[]) ?? [];

      const [editPkIdx, setEditPkIdx] = useState<number | null>(null);
      const updatePk = (i: number, patch: Partial<PK>) =>
        store.set("/primary_key", pks.map((p, j) => j === i ? { ...p, ...patch } : p));
      const pkColRef = useRef<HTMLInputElement>(null);
      const pkPillRef = useRef<HTMLSpanElement>(null);
      const derived = (store.get("/derived_columns") as DC[]) ?? [];

      const [hoveredCol, setHoveredCol] = useState<string | null>(null);
      // Each preview header <th> registers itself here so hovering a row in
      // the Columns table below can scroll the matching preview column into
      // view when the preview table is wider than the viewport.
      const previewHeadRefs = useRef<Map<string, HTMLTableCellElement | null>>(new Map());
      useEffect(() => {
        if (!hoveredCol) return;
        const el = previewHeadRefs.current.get(hoveredCol);
        el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }, [hoveredCol]);

      // Add Column popup state
      const DERIVED_KEY = "__derived__";
      type ColumnStrategy = "lifetime_window" | "prepend_list" | "bitmap_activity";
      const [showAddCol, setShowAddCol] = useState(false);
      const [newColName, setNewColName] = useState("");
      const [newColStrategy, setNewColStrategy] = useState<ColumnStrategy>("lifetime_window");
      const [newColExpr, setNewColExpr] = useState(""); // agg for lifetime_window, expr for prepend_list
      const [newColMaxLength, setNewColMaxLength] = useState(10);
      const [newColGranularity, setNewColGranularity] = useState<"day" | "hour">("day");
      const [newColWindow, setNewColWindow] = useState(365);
      const [newColSource, setNewColSource] = useState("");
      const [newColDesc, setNewColDesc] = useState("");
      const [newColDerived, setNewColDerived] = useState(false);
      const [sourceCols, setSourceCols] = useState<{ name: string; type: string }[]>([]);

      const closeAddCol = () => {
        setShowAddCol(false);
        setNewColName(""); setNewColStrategy("lifetime_window"); setNewColExpr(""); setNewColMaxLength(10); setNewColGranularity("day"); setNewColWindow(365); setNewColSource(""); setNewColDesc(""); setNewColDerived(false); setSourceCols([]);
      };

      // Edit column state
      const [editFamilyKey, setEditFamilyKey] = useState<string | null>(null);
      const [editColIdx, setEditColIdx] = useState<number | null>(null);
      const isEditing = editFamilyKey !== null && editColIdx !== null;

      const startEditCol = (familyKey: string, colIdx: number) => {
        const isD = familyKey === DERIVED_KEY;
        const col = isD ? derived[colIdx] : families.find((f) => f._key === familyKey)?.columns[colIdx];
        if (!col) return;
        setEditFamilyKey(familyKey);
        setEditColIdx(colIdx);
        setNewColName(col.name);
        setNewColDerived(isD);
        if (isD) {
          setNewColExpr((col as DC).expr ?? "");
        } else {
          const fc = col as FCol;
          const strategy = (fc.strategy || "lifetime_window") as ColumnStrategy;
          setNewColStrategy(strategy);
          setNewColExpr(fc.agg || fc.expr || "");
          setNewColMaxLength(fc.max_length ?? 10);
          setNewColGranularity((fc.granularity ?? "day") as "day" | "hour");
          setNewColWindow(fc.window ?? 365);
          setNewColSource(families.find((f) => f._key === familyKey)?.source ?? "");
        }
        setNewColDesc(col.description || "");
        setShowAddCol(true);
      };

      const closePopup = () => {
        closeAddCol();
        setEditFamilyKey(null);
        setEditColIdx(null);
      };

      const buildFamilyCol = (existing: FCol): FCol => {
        const colName = newColName.trim();
        const desc = newColDesc.trim() || undefined;
        switch (newColStrategy) {
          case "lifetime_window":
            return { ...existing, name: colName, strategy: "lifetime_window", agg: newColExpr.trim(), expr: undefined, max_length: undefined, granularity: undefined, window: undefined, description: desc };
          case "prepend_list":
            return { ...existing, name: colName, strategy: "prepend_list", expr: newColExpr.trim(), max_length: newColMaxLength, agg: undefined, granularity: undefined, window: undefined, description: desc };
          case "bitmap_activity":
            return { ...existing, name: colName, strategy: "bitmap_activity", granularity: newColGranularity, window: newColWindow, agg: undefined, expr: undefined, max_length: undefined, description: desc };
        }
      };

      const saveCol = () => {
        if (!isEditing) { addCol(); return; }
        const colName = newColName.trim();
        if (!colName) return;
        // For lifetime_window and prepend_list, expression is required
        if (newColStrategy !== "bitmap_activity" && !newColExpr.trim()) return;
        const desc = newColDesc.trim() || undefined;
        if (editFamilyKey === DERIVED_KEY) {
          store.set("/derived_columns", derived.map((dc, i) =>
            i === editColIdx! ? { ...dc, name: colName, expr: newColExpr.trim(), description: desc } : dc
          ));
        } else {
          store.set("/column_families", families.map((f) => f._key === editFamilyKey
            ? { ...f, columns: f.columns.map((c, i) => i !== editColIdx! ? c : buildFamilyCol(c)) }
            : f
          ));
        }
        closePopup();
      };

      const removeCol = (familyKey: string, colIdx: number) => {
        if (familyKey === DERIVED_KEY) {
          store.set("/derived_columns", derived.filter((_, i) => i !== colIdx));
        } else {
          store.set("/column_families", families.map((f) => f._key === familyKey
            ? { ...f, columns: f.columns.filter((_, i) => i !== colIdx) }
            : f
          ));
        }
      };

      const addCol = () => {
        const colName = newColName.trim();
        if (!colName) return;
        if (newColStrategy !== "bitmap_activity" && !newColExpr.trim()) return;
        const desc = newColDesc.trim() || undefined;
        const source = newColSource.trim();
        if (newColDerived) {
          store.set("/derived_columns", [
            ...derived,
            { _key: genKey("dc"), name: colName, expr: newColExpr.trim(), ...(desc ? { description: desc } : {}) },
          ]);
        } else if (source) {
          const base = { _key: genKey("fc"), name: colName, ...(desc ? { description: desc } : {}) };
          let newCol: FCol;
          switch (newColStrategy) {
            case "lifetime_window":
              newCol = { ...base, strategy: "lifetime_window", agg: newColExpr.trim() } as FCol;
              break;
            case "prepend_list":
              newCol = { ...base, strategy: "prepend_list", expr: newColExpr.trim(), max_length: newColMaxLength } as FCol;
              break;
            case "bitmap_activity":
              newCol = { ...base, strategy: "bitmap_activity", granularity: newColGranularity, window: newColWindow } as FCol;
              break;
          }
          const existing = families.find((f) => f.source === source);
          if (existing) {
            store.set("/column_families", families.map((f) => f._key === existing._key ? { ...f, columns: [...f.columns, newCol] } : f));
          } else {
            const familyName = source.split(".").pop() ?? source;
            const keyMapping = pks.filter((pk) => pk.column).map((pk) => ({ _key: genKey("km"), pk_column: pk.column, source_column: pk.column }));
            store.set("/column_families", [...families, { _key: genKey("cf"), name: familyName, source, key_mapping: keyMapping, columns: [newCol] }]);
          }
        }
        closeAddCol();
      };

      // Build preview columns: PK columns + family columns + derived columns
      const { entities: entityRegistry } = useEntityRegistry();
      const previewCols: { name: string; type: string; source?: string }[] = [
        ...pks.filter((pk) => pk.column).map((pk) => ({ name: pk.column, type: entityRegistry.get(pk.entity)?.id_type ?? "string", source: "pk" })),
        ...families.flatMap((cf) => cf.columns.filter((c) => c.name).map((c) => ({ name: c.name, type: c.strategy || "expr", source: cf.name || "family" }))),
        ...derived.filter((dc) => dc.name).map((dc) => ({ name: dc.name, type: "expr", source: "derived" })),
      ];

      return (
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <Table2 className="h-4 w-4 text-stone-400" />Lattik Table
          </h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="schema.table_name"
              className="w-full border-b border-stone-200 bg-transparent pb-1 text-base font-semibold text-stone-800 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none transition-colors" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what this table represents..."
              className="w-full bg-transparent text-sm text-stone-600 placeholder:text-stone-400 focus:outline-none" />
          </div>

          {/* Retention & Primary Key */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-stone-400">Retention:</span>
              <input type="text" value={retention} onChange={(e) => store.set("/retention", e.target.value)}
                placeholder="30d"
                className="w-12 bg-transparent text-xs font-medium text-stone-800 placeholder:text-stone-400 focus:outline-none border-b border-transparent focus:border-amber-500 transition-colors" />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-stone-400">Primary Key:</span>
              {pks.map((pk, i) => (
                editPkIdx === i ? (
                  <span key={pk._key} ref={pkPillRef}
                    className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 ring-1 ring-amber-300 px-2 py-0.5 text-[10px] font-medium text-stone-700 transition-all">
                    <input ref={pkColRef} type="text" value={pk.column}
                      onChange={(e) => updatePk(i, { column: e.target.value })}
                      onBlur={(e) => { setTimeout(() => { if (!pkPillRef.current?.contains(document.activeElement) && !document.querySelector("[data-entity-popover]")) setEditPkIdx(null); }, 100); }}
                      onKeyDown={(e) => { if (e.key === "Escape") setEditPkIdx(null); if (e.key === "Enter") { e.preventDefault(); setEditPkIdx(null); } }}
                      placeholder="column" autoFocus autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
                      className="w-16 bg-transparent font-mono text-[10px] text-stone-800 placeholder:text-stone-400 focus:outline-none" />
                    <span className="text-stone-300">/</span>
                    <EntityCombobox value={pk.entity} onChange={(v) => updatePk(i, { entity: v })} pkColumn={pk.column} onSubmit={() => setEditPkIdx(null)} />
                    <button onClick={() => { store.set("/primary_key", pks.filter((_, j) => j !== i)); setEditPkIdx(null); }}
                      className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ) : (
                  <button key={pk._key} onClick={() => setEditPkIdx(i)}
                    className="group inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-700 hover:bg-stone-200/70 transition-colors cursor-pointer">
                    <span className="font-mono">{pk.column || "column"}</span>
                    {pk.entity && <span className="text-blue-600">({pk.entity})</span>}
                    {!pk.entity && !pk.column && <span className="text-stone-400 italic">unnamed</span>}
                    <span onClick={(e) => { e.stopPropagation(); store.set("/primary_key", pks.filter((_, j) => j !== i)); }}
                      className="ml-0.5 hidden group-hover:inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <X className="h-2.5 w-2.5" />
                    </span>
                  </button>
                )
              ))}
              <button onClick={() => {
                store.set("/primary_key", [...pks, { _key: genKey("pk"), column: "", entity: "" }]);
                setTimeout(() => setEditPkIdx(pks.length), 0);
              }}
                className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[10px] text-stone-400 hover:border-amber-500 hover:text-amber-600 transition-colors">
                <Plus className="h-2.5 w-2.5" /> add
              </button>
            </div>
          </div>

          {/* Preview */}
          {previewCols.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Preview</span>
              <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-stone-200 bg-stone-50">
                        {previewCols.map((c) => (
                          <th
                            key={c.name}
                            ref={(el) => { previewHeadRefs.current.set(c.name, el); }}
                            className={`px-2.5 py-1.5 text-left font-semibold whitespace-nowrap transition-colors ${hoveredCol === c.name ? "bg-amber-100 text-amber-800" : "text-stone-600"}`}
                          >
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: 3 }, (_, i) => (
                        <tr key={i} className="border-b border-stone-100 last:border-b-0">
                          {previewCols.map((c) => (
                            <td key={c.name} className={`px-2.5 py-1 font-mono text-[10px] whitespace-nowrap transition-colors ${hoveredCol === c.name ? "bg-amber-50 text-amber-700" : "text-stone-500"}`}>
                              {c.source === "pk" ? mockValue(c.type, i, c.name) : c.type === "lifetime_window" ? String(1000 + i * 7) : c.type === "bitmap_activity" ? "0b1010..." : `val_${i + 1}`}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Columns */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Columns</span>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white">
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-stone-50">
                    <tr className="border-b border-stone-200">
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Column</th>
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Type</th>
                      <th className="px-2.5 py-1.5 text-left font-semibold text-stone-600">Description</th>
                      <th className="px-2.5 py-1.5 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                  {/* Primary key columns (locked — they define the grain) */}
                  {pks.filter((pk) => pk.column).map((pk) => (
                    <tr key={pk._key}
                      className={`border-b border-stone-100 transition-colors ${hoveredCol === pk.column ? "bg-amber-50" : ""}`}
                      onMouseEnter={() => setHoveredCol(pk.column)} onMouseLeave={() => setHoveredCol(null)}>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Lock className="h-2.5 w-2.5 text-stone-400" />
                          <span className="font-mono text-xs text-stone-800">{pk.column}</span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-xs text-stone-600 uppercase">{entityRegistry.get(pk.entity)?.id_type ?? "string"}</td>
                      <td className="px-2.5 py-1.5" />
                      <td className="px-1 py-0.5 w-8" />
                    </tr>
                  ))}

                  {/* Family columns */}
                  {families.flatMap((cf) =>
                    cf.columns.filter((c) => c.name).map((c, cIdx) => (
                      <tr key={c._key}
                        className={`border-b border-stone-100 group transition-colors cursor-pointer ${hoveredCol === c.name ? "bg-amber-50" : ""}`}
                        onMouseEnter={() => setHoveredCol(c.name)} onMouseLeave={() => setHoveredCol(null)}
                        onClick={() => startEditCol(cf._key, cIdx)}>
                        <td className="px-2.5 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-stone-800">{c.name}</span>
                            {c.strategy && <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700">{c.strategy === "lifetime_window" ? "lifetime" : c.strategy === "prepend_list" ? "list" : "bitmap"}</span>}
                          </div>
                        </td>
                        <td className="px-2.5 py-1.5 text-xs text-stone-600 uppercase">{c.type || ""}</td>
                        <td className="px-2.5 py-1.5 text-[10px] text-stone-400">{c.description || ""}</td>
                        <td className="px-1 py-0.5 w-8">
                          <button onClick={(e) => { e.stopPropagation(); removeCol(cf._key, cIdx); }}
                            className="flex h-5 w-5 items-center justify-center rounded text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}

                  {/* Derived columns */}
                  {derived.filter((dc) => dc.name).map((dc, dcIdx) => (
                    <tr key={dc._key}
                      className={`border-b border-stone-100 group transition-colors cursor-pointer ${hoveredCol === dc.name ? "bg-amber-50" : ""}`}
                      onMouseEnter={() => setHoveredCol(dc.name)} onMouseLeave={() => setHoveredCol(null)}
                      onClick={() => startEditCol(DERIVED_KEY, dcIdx)}>
                      <td className="px-2.5 py-1.5">
                        <span className="font-mono text-xs text-stone-800">{dc.name}</span>
                      </td>
                      <td className="px-2.5 py-1.5" />
                      <td className="px-2.5 py-1.5 text-[10px] text-stone-400">{dc.description || ""}</td>
                      <td className="px-1 py-0.5 w-8">
                        <button onClick={(e) => { e.stopPropagation(); removeCol(DERIVED_KEY, dcIdx); }}
                          className="flex h-5 w-5 items-center justify-center rounded text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}

                  {/* Add column button */}
                  <tr>
                    <td colSpan={4} className="px-2.5 py-1.5">
                      <button onClick={() => setShowAddCol(true)}
                        className="flex items-center gap-1.5 rounded-md border border-dashed border-stone-300 px-2.5 py-1.5 text-[11px] text-stone-500 hover:border-amber-500 hover:text-amber-700 hover:bg-amber-50/50 transition-colors w-full justify-center">
                        <Plus className="h-3 w-3" /> Add column
                      </button>
                    </td>
                  </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Review table button — sits below the scrollable columns table */}
          {previewCols.length > 0 && (
            <button
              onClick={() => sendChatMessage("Review table")}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
            >
              <Send className="h-3.5 w-3.5" />
              Review Table
            </button>
          )}

          {/* Column popup (add / edit) */}
          {showAddCol && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-[1px] rounded-lg" onClick={closePopup}>
              <div className="w-[22rem] rounded-xl border border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === "Escape") closePopup(); if (e.key === "Enter") { e.preventDefault(); saveCol(); } }}>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-amber-50 border-b border-amber-100 rounded-t-xl">
                  <span className="text-[11px] font-medium text-amber-700">{isEditing ? "Edit Column" : "Add Column"}</span>
                  <button onClick={closePopup} className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-amber-700 transition-colors">
                    <X className="h-3 w-3" />
                  </button>
                </div>

                {/* Body */}
                <div className="flex flex-col gap-4 px-4 py-4">
                  {/* Name */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Column name</label>
                    <input type="text" value={newColName} onChange={(e) => setNewColName(e.target.value)}
                      placeholder="e.g. click_count" autoFocus maxLength={60}
                      className="w-full bg-transparent text-sm font-semibold font-mono text-stone-800 placeholder:text-stone-300 placeholder:font-normal focus:outline-none" />
                  </div>

                  {/* Mode toggle (hidden when editing) */}
                  {!isEditing && (
                    <div className="flex rounded-lg bg-stone-100 p-0.5">
                      <button type="button" tabIndex={-1} onClick={() => setNewColDerived(false)}
                        className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${!newColDerived ? "bg-white text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
                        From source
                      </button>
                      <button type="button" tabIndex={-1} onClick={() => { setNewColDerived(true); setNewColSource(""); }}
                        className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${newColDerived ? "bg-white text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
                        Derived
                      </button>
                    </div>
                  )}

                  {/* Source mode fields */}
                  {!newColDerived && (
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Source table</label>
                      <SourceTableCombobox value={newColSource} onChange={setNewColSource} onColumnsLoaded={setSourceCols} />
                    </div>
                  )}

                  {/* Strategy selector (source mode only) */}
                  {!newColDerived && (
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Strategy</label>
                      <select value={newColStrategy} onChange={(e) => setNewColStrategy(e.target.value as ColumnStrategy)}
                        className="bg-transparent text-xs text-stone-700 focus:outline-none">
                        <option value="lifetime_window">Lifetime Window</option>
                        <option value="prepend_list">Prepend List</option>
                        <option value="bitmap_activity">Bitmap Activity</option>
                      </select>
                    </div>
                  )}

                  {/* Strategy-specific fields */}
                  {newColDerived ? (
                    <ExpressionInput
                      value={newColExpr}
                      onChange={setNewColExpr}
                      label="Expression"
                      placeholder="e.g. revenue / session_count"
                      sourceCols={[]}
                    />
                  ) : newColStrategy === "lifetime_window" ? (
                    <ExpressionInput
                      value={newColExpr}
                      onChange={setNewColExpr}
                      label="Aggregation"
                      placeholder="e.g. sum(amount), count()"
                      sourceCols={sourceCols}
                    />
                  ) : newColStrategy === "prepend_list" ? (
                    <>
                      <ExpressionInput
                        value={newColExpr}
                        onChange={setNewColExpr}
                        label="Value expression"
                        placeholder="e.g. country, product_id"
                        sourceCols={sourceCols}
                      />
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Max list length</label>
                        <input type="number" value={newColMaxLength} onChange={(e) => setNewColMaxLength(Number(e.target.value))}
                          min={1} max={1000}
                          className="w-20 bg-transparent text-xs text-stone-700 focus:outline-none" />
                      </div>
                    </>
                  ) : newColStrategy === "bitmap_activity" ? (
                    <div className="flex gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Granularity</label>
                        <select value={newColGranularity} onChange={(e) => setNewColGranularity(e.target.value as "day" | "hour")}
                          className="bg-transparent text-xs text-stone-700 focus:outline-none">
                          <option value="day">day</option>
                          <option value="hour">hour</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Window (slots)</label>
                        <input type="number" value={newColWindow} onChange={(e) => setNewColWindow(Number(e.target.value))}
                          min={1} max={8760}
                          className="w-20 bg-transparent text-xs text-stone-700 focus:outline-none" />
                      </div>
                    </div>
                  ) : null}

                  {/* Description */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-stone-400">Description</label>
                    <input type="text" value={newColDesc} onChange={(e) => setNewColDesc(e.target.value)}
                      placeholder="Optional"
                      className="w-full bg-transparent text-xs text-stone-500 placeholder:text-stone-300 focus:outline-none" />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-100">
                    <button onClick={closePopup}
                      className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors">
                      Cancel
                    </button>
                    <button onClick={saveCol}
                      disabled={!newColName.trim() || (newColStrategy !== "bitmap_activity" && !newColExpr.trim()) || (!newColDerived && !newColSource.trim())}
                      className="rounded-full bg-stone-800 px-3 py-1 text-[11px] font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors">
                      {isEditing ? "Save" : "Add"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    },

    YamlEditor: () => {
      const { sendChatMessage } = useCanvasActions();
      const store = useStateStore();
      const kind = (store.get("/kind") as string) ?? "";
      const name = (store.get("/name") as string) ?? "";
      const files =
        (store.get("/files") as { _key?: string; path: string; content: string }[]) ?? [];
      const activeFile = (store.get("/active_file") as number) ?? 0;
      const safeIdx = files.length === 0 ? 0 : Math.min(Math.max(activeFile, 0), files.length - 1);
      const current = files[safeIdx];

      const updateContent = (value: string) => {
        const next = files.map((f, i) => (i === safeIdx ? { ...f, content: value } : f));
        store.set("/files", next);
      };

      const kindLabel = kind ? kind.replace(/_/g, " ") : "definition";

      return (
        <div className="flex flex-col gap-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <FileCode className="h-4 w-4 text-stone-400" />
            YAML Preview
            {name && (
              <span className="ml-1 text-xs font-normal text-stone-500">
                — {kindLabel}: <span className="font-mono">{name}</span>
              </span>
            )}
          </h2>

          <p className="text-xs text-stone-500">
            Review the generated YAML below. You can edit it directly before submitting a PR.
          </p>

          {/* File tabs */}
          {files.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 border-b border-stone-200">
              {files.map((f, i) => {
                const fileName = f.path.split("/").pop() ?? f.path;
                const isActive = i === safeIdx;
                return (
                  <button
                    key={f._key ?? f.path}
                    onClick={() => store.set("/active_file", i)}
                    className={`flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors ${
                      isActive
                        ? "border-amber-500 bg-amber-50/50 font-medium text-amber-700"
                        : "border-transparent text-stone-500 hover:bg-stone-50 hover:text-stone-700"
                    }`}
                    title={f.path}
                  >
                    <FileCode className="h-3 w-3" />
                    {fileName}
                  </button>
                );
              })}
            </div>
          )}

          {/* Editor */}
          {current ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px] text-stone-400">
                <span className="font-mono">{current.path}</span>
                <span>{current.content.split("\n").length} lines</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                <CodeMirror
                  value={current.content}
                  onChange={updateContent}
                  extensions={[yamlLanguage()]}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    bracketMatching: true,
                  }}
                  style={{ fontSize: "12px" }}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">
              No YAML files generated.
            </div>
          )}

          {/* Submit PR button — sticks to the bottom of the canvas scroll container */}
          <div className="sticky bottom-0 -mx-5 mt-auto -mb-5 border-t border-stone-200 bg-stone-50/95 px-5 py-3 backdrop-blur-sm">
            <button
              onClick={() => sendChatMessage("Create the PR")}
              disabled={files.length === 0}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              Create PR
            </button>
          </div>
        </div>
      );
    },

    PRSubmittedCard: ({ props }) => {
      const kindLabel = props.kind ? props.kind.replace(/_/g, " ") : "definition";
      return (
        <div className="flex flex-col gap-5">
          {/* Hero */}
          <div className="relative overflow-hidden rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-amber-50 p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 ring-4 ring-emerald-50">
                <PartyPopper className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold text-stone-800">PR submitted successfully</h2>
                <p className="text-xs text-stone-500">
                  Your {kindLabel}{" "}
                  <span className="font-mono text-stone-700">{props.name}</span> is ready for
                  review.
                </p>
              </div>
            </div>
          </div>

          {/* PR card */}
          <a
            href={props.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-4 transition-colors hover:border-amber-300 hover:bg-amber-50/30"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-purple-100 text-purple-600">
                <GitPullRequest className="h-4 w-4" />
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-stone-500">Pull Request</span>
                <span className="text-sm font-semibold text-stone-800 group-hover:text-amber-700">
                  #{props.prNumber} — Define {kindLabel}: {props.name}
                </span>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-stone-400 group-hover:text-amber-600" />
          </a>

          {/* Branch */}
          <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50/50 px-3 py-2">
            <GitBranch className="h-3.5 w-3.5 text-stone-400" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">
              Branch
            </span>
            <span className="ml-1 truncate font-mono text-xs text-stone-700">{props.branch}</span>
          </div>

          {/* Files */}
          {props.files.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">
                Files committed ({props.files.length})
              </span>
              <ul className="flex flex-col gap-1 rounded-lg border border-stone-200 bg-white p-2">
                {props.files.map((path: string) => (
                  <li
                    key={path}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                  >
                    <FileCode className="h-3.5 w-3.5 shrink-0 text-stone-400" />
                    <span className="truncate font-mono">{path}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* CTA */}
          <a
            href={props.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
          >
            View PR in Gitea
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      );
    },
  },
  actions: {},
});
