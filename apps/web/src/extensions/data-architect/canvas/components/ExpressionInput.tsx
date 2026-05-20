"use client";

import { useRef, useState } from "react";
import { parse } from "@eloquio/lattik-expression";
import { AGGREGATE_FUNCTIONS, FN_PARAMS, SCALAR_FUNCTIONS } from "../lib/constants";
import { tokenAtCursor } from "../lib/helpers";
import type { TabStop } from "../lib/types";

export function ExpressionInput({
  value,
  onChange,
  label,
  placeholder,
  sourceCols,
}: {
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

  const applySuggestion = (s: (typeof suggestions)[number]) => {
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
        setTimeout(
          () => inputRef.current?.setSelectionRange(tabStops[nextIdx][0], tabStops[nextIdx][1]),
          0,
        );
        return;
      }
      // Last tab stop — clear state and let Tab fall through to next form field
      setTabStops([]);
      setTabIdx(-1);
      return;
    }

    // Dropdown navigation — only arrow keys, Enter, and Escape; never Tab
    if (showDropdown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((prev) => (prev + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
      } else if (e.key === "Enter") {
        const idx = activeIdx >= 0 ? activeIdx : 0;
        if (idx < suggestions.length) {
          e.preventDefault();
          e.stopPropagation();
          applySuggestion(suggestions[idx]);
        }
      } else if (e.key === "Escape") {
        setOpen(false);
      }
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
      setTabStops((prev) =>
        prev.map((s, i) => {
          if (i < tabIdx) return s;
          if (i === tabIdx) return [s[0], s[0] + newLen];
          return [s[0] + delta, s[1] + delta];
        }),
      );
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
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            if (!containerRef.current?.contains(e.relatedTarget))
              setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full bg-transparent text-xs font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none"
        />
        {isValid && (
          <span className="shrink-0 rounded bg-green-50 px-1 py-0.5 text-[9px] font-medium text-green-600 ring-1 ring-green-200/50">
            valid
          </span>
        )}
      </div>
      {hasError && <p className="text-[10px] text-red-500">{parseResult.errors[0].message}</p>}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={s.label}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(s);
              }}
              className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-xs transition-colors ${i === activeIdx ? "bg-stone-100" : "hover:bg-stone-50"}`}
            >
              <span className={`font-mono ${s.kind === "fn" ? "text-amber-700" : "text-blue-700"}`}>
                {s.label}
              </span>
              <span className="text-[9px] text-stone-400">{s.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
