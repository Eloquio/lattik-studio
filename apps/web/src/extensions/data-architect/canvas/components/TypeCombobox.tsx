"use client";

import { useRef, useState } from "react";
import { fromColumnType } from "@eloquio/lattik-expression";
import { TYPE_OPTIONS } from "../lib/constants";

export function TypeCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(value);
  const [activeIdx, setActiveIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const filtered = TYPE_OPTIONS.filter(
    (t) => t.includes(input.toLowerCase()) || t.toUpperCase().includes(input.toUpperCase()),
  );
  const resolved = fromColumnType(input);
  const isValid = resolved !== "unknown" || input === "";

  const select = (t: string) => {
    setInput(t);
    onChange(t);
    setOpen(false);
    setActiveIdx(-1);
  };

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
      <input
        type="text"
        value={input.toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.toLowerCase();
          setInput(v);
          onChange(v);
          setOpen(true);
          setActiveIdx(-1);
        }}
        onFocus={() => {
          setOpen(true);
          setActiveIdx(-1);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
        placeholder="What's the data type of this column?"
        className={`w-full bg-transparent text-xs text-stone-600 placeholder:text-stone-300 placeholder:normal-case focus:outline-none ${input ? "uppercase" : ""} ${!isValid && input ? "text-red-500" : ""}`}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-stone-200 bg-white py-1 shadow-lg max-h-36 overflow-y-auto">
          {filtered.map((t, i) => (
            <button
              key={t}
              onMouseDown={(e) => {
                e.preventDefault();
                select(t);
              }}
              className={`block w-full px-2.5 py-1 text-left text-xs uppercase transition-colors ${i === activeIdx ? "bg-stone-100 text-amber-700 font-medium" : t === input ? "text-amber-700 font-medium" : "text-stone-700 hover:bg-stone-50"}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
