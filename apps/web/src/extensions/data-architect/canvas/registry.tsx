"use client";

import { defineRegistry, useStateStore } from "@json-render/react";
import { Check, X, Plus, Trash2, Lock } from "lucide-react";
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
  "rounded-md border border-amber-200/50 bg-white/90 px-2.5 py-1.5 text-xs text-amber-900 placeholder:text-amber-400/60 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/30";

// ---- Column helpers ----
interface UserColumn { _key: string; name: string; type: string }
const TYPE_OPTIONS = ["string", "int32", "int64", "float", "double", "boolean", "timestamp", "date", "json"];
let _nextKey = 0;
function genKey(prefix = "k") { return `${prefix}_${++_nextKey}_${Date.now()}`; }

const IMPLICIT_TOP = [{ name: "event_id", type: "string" }, { name: "event_timestamp", type: "timestamp" }];
const IMPLICIT_BOTTOM = [{ name: "ds", type: "date" }, { name: "hour", type: "int32" }];

function ImplicitRow({ name, type }: { name: string; type: string }) {
  return (
    <tr className="border-b border-amber-100/30">
      <td className="px-2.5 py-1.5 font-mono text-xs text-amber-900/40">{name}</td>
      <td className="px-2.5 py-1.5 text-xs text-amber-500/40">{type}</td>
      <td className="px-2.5 py-1.5 w-8"><Lock className="h-3 w-3 text-amber-300/40" /></td>
    </tr>
  );
}

// ---- Mock data generator ----
function mockValue(type: string, i: number): string {
  switch (type) {
    case "int32": case "int64": return String(1000 + i * 7);
    case "float": case "double": return (Math.random() * 100).toFixed(2);
    case "boolean": return i % 2 === 0 ? "true" : "false";
    case "timestamp": return new Date(Date.now() - i * 86400000).toISOString().slice(0, 19);
    case "date": return new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
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
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            {props.title}
          </h3>
        )}
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    ),

    Heading: ({ props }) => (
      <div className="mb-2">
        <h2 className="text-lg font-semibold text-amber-900">{props.title}</h2>
        {props.subtitle && <p className="mt-0.5 text-sm text-amber-700/60">{props.subtitle}</p>}
      </div>
    ),

    // --- Form fields ---
    TextInput: ({ props }) => {
      const [value, setValue] = useField(props.field);
      const v = (value as string) ?? props.defaultValue ?? "";

      if (props.variant === "title") {
        return (
          <input type="text" value={v} onChange={(e) => setValue(e.target.value)}
            placeholder={props.placeholder}
            className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
        );
      }
      if (props.variant === "subtitle") {
        return (
          <input type="text" value={v} onChange={(e) => setValue(e.target.value)}
            placeholder={props.placeholder}
            className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
        );
      }
      return (
        <div className="flex flex-col gap-1">
          {props.label && (
            <label className="text-xs font-semibold text-amber-800">
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
          <label className="text-xs font-semibold text-amber-800">
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
            className="h-3.5 w-3.5 rounded border-amber-300 text-amber-600 focus:ring-amber-400/30" />
          <span className="text-xs text-amber-800">{props.label}</span>
        </label>
      );
    },

    // --- Data display ---
    DataTable: ({ props }) => {
      if (!props.columns.length) return null;
      return (
        <div className="overflow-hidden rounded-lg border border-amber-200/50 bg-white/80">
          {props.title && (
            <div className="border-b border-amber-200/50 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/60">{props.title}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-amber-100/50 bg-amber-50/50">
                  {props.columns.map((c) => (
                    <th key={c.key} className="px-2.5 py-1 text-left font-semibold text-amber-800">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row, i) => (
                  <tr key={i} className="border-b border-amber-100/30 last:border-b-0">
                    {props.columns.map((c) => (
                      <td key={c.key} className="px-2.5 py-1 text-amber-900/60">{String(row[c.key] ?? "")}</td>
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
        Object.fromEntries(cols.map((c) => [c.name, mockValue(c.type, i)]))
      );
      return (
        <div className="overflow-hidden rounded-lg border border-amber-200/50 bg-white/80">
          {props.title && (
            <div className="border-b border-amber-200/50 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/60">{props.title}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-amber-100/50 bg-amber-50/50">
                  {cols.map((c) => (
                    <th key={c.name} className="px-2.5 py-1 text-left font-semibold text-amber-800">
                      <div>{c.name}</div>
                      <div className="font-normal text-amber-500/60 text-[9px]">{c.type}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-amber-100/30 last:border-b-0">
                    {cols.map((c) => (
                      <td key={c.name} className="px-2.5 py-1 font-mono text-amber-900/60 text-[10px]">{String(row[c.name])}</td>
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
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">{props.label}</span>
              <button onClick={add} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
          )}
          {columns.map((col, i) => (
            <div key={col._key ?? `idx_${i}`} className="flex items-start gap-1.5 rounded-md border border-amber-200/30 bg-white/60 px-2 py-1.5">
              <input type="text" value={col.name} onChange={(e) => update(i, { name: e.target.value })}
                placeholder="column_name" maxLength={60}
                className="flex-1 min-w-0 rounded border-0 bg-transparent px-1 py-0.5 text-xs font-mono text-amber-900 placeholder:text-amber-400/50 focus:outline-none" />
              <select value={col.type} onChange={(e) => update(i, { type: e.target.value })}
                className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-amber-700 focus:outline-none">
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={() => remove(i)} className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {columns.length === 0 && (
            <button onClick={add} className="rounded-md border border-dashed border-amber-300/50 px-3 py-2 text-xs text-amber-600/60 hover:bg-amber-50/50 transition-colors">
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
      const borderColor = sev === "error" ? "border-red-300/50" : sev === "warning" ? "border-amber-300/50" : "border-blue-300/50";
      const bgColor = d === "accepted" ? "bg-green-50/50" : d === "denied" ? "bg-red-50/30" : "bg-white/80";

      return (
        <div className={`rounded-lg border ${borderColor} ${bgColor} px-3 py-2 transition-colors`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="text-xs font-semibold text-amber-900">{props.title}</div>
              <div className="mt-0.5 text-[11px] text-amber-700/70">{props.description}</div>
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
          {props.step && <span className="text-[10px] text-amber-600/50">{props.step}</span>}
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

      const updateCol = (i: number, patch: Partial<UserColumn>) =>
        store.set("/user_columns", columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      const addCol = () =>
        store.set("/user_columns", [...columns, { _key: genKey("col"), name: "", type: "string" }]);
      const removeCol = (i: number) =>
        store.set("/user_columns", columns.filter((_, j) => j !== i));

      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-amber-900">Define a New Logger Table</h2>
          <div className="flex flex-col gap-1">
            <input type="text" value={name} onChange={(e) => store.set("/name", e.target.value)}
              placeholder="schema.table_name"
              className="w-full bg-transparent text-base font-semibold text-amber-900 placeholder:text-amber-400/40 focus:outline-none" />
            <input type="text" value={description} onChange={(e) => store.set("/description", e.target.value)}
              placeholder="Describe what events this table captures..."
              className="w-full bg-transparent text-sm text-amber-700/70 placeholder:text-amber-400/40 focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">Retention</label>
              <input type="text" value={retention} onChange={(e) => store.set("/retention", e.target.value)}
                placeholder="e.g. 30d" className={inputCls} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-amber-800">Dedup Window</label>
              <input type="text" value={dedupWindow} onChange={(e) => store.set("/dedup_window", e.target.value)}
                placeholder="e.g. 1h" className={inputCls} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">Columns</span>
            <div className="overflow-hidden rounded-lg border border-amber-200/50 bg-white/80">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-amber-100/50 bg-amber-50/50">
                    <th className="px-2.5 py-1.5 text-left font-semibold text-amber-800">Column</th>
                    <th className="px-2.5 py-1.5 text-left font-semibold text-amber-800">Type</th>
                    <th className="px-2.5 py-1.5 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {IMPLICIT_TOP.map((c) => <ImplicitRow key={c.name} name={c.name} type={c.type} />)}
                  {columns.map((col, i) => (
                    <tr key={col._key} className="border-b border-amber-100/30">
                      <td className="px-1 py-0.5">
                        <input type="text" value={col.name} onChange={(e) => updateCol(i, { name: e.target.value })}
                          placeholder="column_name" maxLength={60}
                          className="w-full rounded bg-transparent px-1.5 py-1 font-mono text-xs text-amber-900 placeholder:text-amber-400/50 focus:outline-none focus:bg-amber-50/50" />
                      </td>
                      <td className="px-1 py-0.5">
                        <select value={col.type} onChange={(e) => updateCol(i, { type: e.target.value })}
                          className="rounded bg-transparent px-1 py-1 text-xs text-amber-700 focus:outline-none focus:bg-amber-50/50">
                          {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-0.5 w-8">
                        <button onClick={() => removeCol(i)}
                          className="flex h-5 w-5 items-center justify-center rounded text-amber-400 hover:text-red-500 transition-colors">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-b border-amber-100/30">
                    <td colSpan={3} className="px-2.5 py-0.5">
                      <button onClick={addCol}
                        className="flex items-center gap-1 rounded px-1 py-1 text-[11px] text-amber-600 hover:bg-amber-100/50 transition-colors">
                        <Plus className="h-3 w-3" /> Add column
                      </button>
                    </td>
                  </tr>
                  {IMPLICIT_BOTTOM.map((c) => <ImplicitRow key={c.name} name={c.name} type={c.type} />)}
                </tbody>
              </table>
            </div>
          </div>
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
