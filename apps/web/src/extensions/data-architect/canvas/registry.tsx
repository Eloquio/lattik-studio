"use client";

import { useRef, useState } from "react";
import { defineRegistry, useStateStore } from "@json-render/react";
import { Check, X, Plus, Trash2, Lock, Table2 } from "lucide-react";
import type { ScalarTypeKind } from "@eloquio/lattik-expression";
import { fromColumnType } from "@eloquio/lattik-expression";
import { catalog } from "./catalog";

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
interface UserColumn { _key: string; name: string; type: string; description?: string; dimension?: string; pii?: boolean }
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const TYPE_OPTIONS: ScalarTypeKind[] = ["string", "int32", "int64", "float", "double", "boolean", "timestamp", "date", "json"];
const TYPE_DISPLAY: Record<string, string> = Object.fromEntries(TYPE_OPTIONS.map((t) => [t, t.toUpperCase()]));

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
      const sev = props.severity ?? "info";
      const borderColor = sev === "error" ? "border-red-300" : sev === "warning" ? "border-amber-300" : "border-blue-200";
      const bgColor = d === "accepted" ? "bg-green-50/50" : d === "denied" ? "bg-red-50/30" : "bg-white";

      return (
        <div className={`rounded-lg border ${borderColor} ${bgColor} px-3 py-2 transition-colors`}>
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
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";
      const retention = (store.get("/retention") as string) ?? "30d";
      const dedupWindow = (store.get("/dedup_window") as string) ?? "1h";
      const columns = (store.get("/user_columns") as UserColumn[]) ?? [];

      const [hoveredCol, setHoveredCol] = useState<string | null>(null);
      const [showAddCol, setShowAddCol] = useState(false);
      const [newColName, setNewColName] = useState("");
      const [newColType, setNewColType] = useState("");
      const [newColDesc, setNewColDesc] = useState("");
      const [newColDim, setNewColDim] = useState("");
      const [newColPii, setNewColPii] = useState(false);
      const [editIdx, setEditIdx] = useState<number | null>(null);
      const [editName, setEditName] = useState("");
      const [editType, setEditType] = useState("string");
      const [editDesc, setEditDesc] = useState("");
      const [editDim, setEditDim] = useState("");
      const [editPii, setEditPii] = useState(false);

      const updateCol = (i: number, patch: Partial<UserColumn>) =>
        store.set("/user_columns", columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      const addCol = () => {
        if (!newColName.trim()) return;
        const dim = newColDim.trim() || undefined;
        if (dim && !SNAKE_CASE_RE.test(dim)) return;
        store.set("/user_columns", [...columns, { _key: genKey("col"), name: newColName.trim(), type: newColType, description: newColDesc.trim() || undefined, dimension: dim, pii: newColPii || undefined }]);
        setNewColName(""); setNewColType(""); setNewColDesc(""); setNewColDim(""); setNewColPii(false);
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
        setEditPii(columns[i].pii ?? false);
      };
      const saveEdit = () => {
        if (editIdx === null || !editName.trim()) return;
        const dim = editDim.trim() || undefined;
        if (dim && !SNAKE_CASE_RE.test(dim)) return;
        updateCol(editIdx, { name: editName.trim(), type: editType, description: editDesc.trim() || undefined, dimension: dim, pii: editPii || undefined });
        setEditIdx(null);
      };
      const cancelEdit = () => setEditIdx(null);
      const closePopup = () => { setShowAddCol(false); cancelEdit(); setNewColName(""); setNewColType(""); setNewColDesc(""); setNewColDim(""); setNewColPii(false); };

      const allPreviewCols = [...IMPLICIT_TOP, ...columns.filter((c) => c.name), ...IMPLICIT_BOTTOM];

      return (
        <div className="flex flex-col gap-5">
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
                        <th key={c.name} className={`px-2.5 py-1.5 text-left font-semibold whitespace-nowrap transition-colors ${hoveredCol === c.name ? "bg-amber-100 text-amber-800" : "text-stone-600"}`}>
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
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Columns</span>
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50">
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
                          {col.pii && <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-600">PII</span>}
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
                  {/* PII + Name */}
                  <div className="flex items-center gap-2">
                    <button type="button"
                      onClick={() => editIdx !== null ? setEditPii(!editPii) : setNewColPii(!newColPii)}
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${(editIdx !== null ? editPii : newColPii) ? "bg-red-100 text-red-600 ring-1 ring-red-200" : "bg-stone-100 text-stone-400 hover:bg-stone-200 hover:text-stone-600"}`}>
                      PII
                    </button>
                    <input type="text" value={editIdx !== null ? editName : newColName}
                      onChange={(e) => editIdx !== null ? setEditName(e.target.value) : setNewColName(e.target.value)}
                      placeholder="new_column_name" autoFocus maxLength={60}
                      className="flex-1 min-w-0 bg-transparent text-sm font-semibold font-mono text-stone-800 placeholder:text-stone-300 placeholder:font-sans placeholder:font-normal focus:outline-none" />
                  </div>

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

                  {/* Dimension + Entity */}
                  {(() => {
                    const dimVal = editIdx !== null ? editDim : newColDim;
                    const dimInvalid = dimVal.length > 0 && !SNAKE_CASE_RE.test(dimVal);
                    return (<div className="flex flex-col gap-1">
                      <input type="text" value={dimVal}
                        onChange={(e) => editIdx !== null ? setEditDim(e.target.value) : setNewColDim(e.target.value)}
                        placeholder="Bind to dimension if applicable"
                        className={`flex-1 min-w-0 bg-transparent text-xs text-stone-600 placeholder:text-stone-300 focus:outline-none ${dimInvalid ? "text-red-500" : ""}`} />
                      {dimInvalid && <span className="text-[10px] text-red-500">Must be snake_case</span>}
                    </div>);
                  })()}

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
            <input type="text" value={entity} onChange={(e) => store.set("/entity", e.target.value)}
              placeholder="e.g. user" className={inputCls} />
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
      const store = useStateStore();
      const name = (store.get("/name") as string) ?? "";
      const description = (store.get("/description") as string) ?? "";

      interface PK { _key: string; column: string; entity: string }
      interface FCol { _key: string; name: string; agg?: string; merge?: string }
      interface CF { _key: string; name: string; source: string; columns: FCol[] }
      interface DC { _key: string; name: string; expr: string }

      const pks = (store.get("/primary_key") as PK[]) ?? [];
      const families = (store.get("/column_families") as CF[]) ?? [];
      const derived = (store.get("/derived_columns") as DC[]) ?? [];

      const MERGE = ["sum", "max", "min", "replace"] as const;

      return (
        <div className="flex flex-col gap-5">
          <h2 className="text-lg font-semibold text-amber-900">Define a New Lattik Table</h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="table_name" className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what this table represents..."
              className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
          </div>

          {/* Primary Key */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">Primary Key</span>
              <button onClick={() => store.set("/primary_key", [...pks, { _key: genKey("pk"), column: "", entity: "" }])}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {pks.map((pk, i) => (
              <div key={pk._key} className="flex items-center gap-1.5">
                <input type="text" value={pk.column} onChange={(e) => store.set("/primary_key", pks.map((p, j) => j === i ? { ...p, column: e.target.value } : p))}
                  placeholder="column" className={`flex-1 ${inputCls}`} />
                <input type="text" value={pk.entity} onChange={(e) => store.set("/primary_key", pks.map((p, j) => j === i ? { ...p, entity: e.target.value } : p))}
                  placeholder="entity" className={`flex-1 ${inputCls}`} />
                <button onClick={() => store.set("/primary_key", pks.filter((_, j) => j !== i))}
                  className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {pks.length === 0 && (
              <button onClick={() => store.set("/primary_key", [{ _key: genKey("pk"), column: "", entity: "" }])}
                className="rounded-md border border-dashed border-amber-300/50 px-3 py-2 text-xs text-amber-600/60 hover:bg-amber-50/50 transition-colors">
                Add primary key column...
              </button>
            )}
          </div>

          {/* Column Families */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">Column Families</span>
              <button onClick={() => store.set("/column_families", [...families, { _key: genKey("cf"), name: "", source: "", columns: [] }])}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                <Plus className="h-3 w-3" /> Add Family
              </button>
            </div>
            {families.map((cf, fi) => (
              <div key={cf._key} className="flex flex-col gap-2 rounded-lg border border-amber-200/30 bg-white/60 p-2.5">
                <div className="flex items-center gap-1.5">
                  <input type="text" value={cf.name} onChange={(e) => store.set("/column_families", families.map((f, j) => j === fi ? { ...f, name: e.target.value } : f))}
                    placeholder="Family name" className={`flex-1 ${inputCls}`} />
                  <input type="text" value={cf.source} onChange={(e) => store.set("/column_families", families.map((f, j) => j === fi ? { ...f, source: e.target.value } : f))}
                    placeholder="Source table" className={`flex-1 ${inputCls}`} />
                  <button onClick={() => store.set("/column_families", families.filter((_, j) => j !== fi))}
                    className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <div className="ml-2 flex flex-col gap-1">
                  {cf.columns.map((col, ci) => (
                    <div key={col._key} className="flex items-center gap-1">
                      <input type="text" value={col.name} onChange={(e) => {
                        const newFams = families.map((f, j) => j === fi ? { ...f, columns: f.columns.map((c, k) => k === ci ? { ...c, name: e.target.value } : c) } : f);
                        store.set("/column_families", newFams);
                      }} placeholder="name" className={`flex-1 min-w-0 ${inputCls} font-mono`} />
                      <input type="text" value={col.agg ?? ""} onChange={(e) => {
                        const newFams = families.map((f, j) => j === fi ? { ...f, columns: f.columns.map((c, k) => k === ci ? { ...c, agg: e.target.value } : c) } : f);
                        store.set("/column_families", newFams);
                      }} placeholder="agg expr" className={`flex-1 min-w-0 ${inputCls} font-mono`} />
                      <select value={col.merge ?? ""} onChange={(e) => {
                        const newFams = families.map((f, j) => j === fi ? { ...f, columns: f.columns.map((c, k) => k === ci ? { ...c, merge: e.target.value || undefined } : c) } : f);
                        store.set("/column_families", newFams);
                      }} className={`w-20 ${inputCls}`}>
                        <option value="">merge</option>
                        {MERGE.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <button onClick={() => {
                        const newFams = families.map((f, j) => j === fi ? { ...f, columns: f.columns.filter((_, k) => k !== ci) } : f);
                        store.set("/column_families", newFams);
                      }} className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => {
                    const newFams = families.map((f, j) => j === fi ? { ...f, columns: [...f.columns, { _key: genKey("fc"), name: "" }] } : f);
                    store.set("/column_families", newFams);
                  }} className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                    <Plus className="h-3 w-3" /> Add column
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Derived Columns */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">Derived Columns</span>
              <button onClick={() => store.set("/derived_columns", [...derived, { _key: genKey("dc"), name: "", expr: "" }])}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {derived.map((dc, i) => (
              <div key={dc._key} className="flex items-center gap-1.5">
                <input type="text" value={dc.name} onChange={(e) => store.set("/derived_columns", derived.map((d, j) => j === i ? { ...d, name: e.target.value } : d))}
                  placeholder="name" className={`flex-1 min-w-0 ${inputCls} font-mono`} />
                <input type="text" value={dc.expr} onChange={(e) => store.set("/derived_columns", derived.map((d, j) => j === i ? { ...d, expr: e.target.value } : d))}
                  placeholder="expression" className={`flex-1 min-w-0 ${inputCls} font-mono`} />
                <button onClick={() => store.set("/derived_columns", derived.filter((_, j) => j !== i))}
                  className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {derived.length === 0 && (
              <button onClick={() => store.set("/derived_columns", [{ _key: genKey("dc"), name: "", expr: "" }])}
                className="rounded-md border border-dashed border-amber-300/50 px-3 py-2 text-xs text-amber-600/60 hover:bg-amber-50/50 transition-colors">
                Add derived column...
              </button>
            )}
          </div>
        </div>
      );
    },
  },
  actions: {},
});
