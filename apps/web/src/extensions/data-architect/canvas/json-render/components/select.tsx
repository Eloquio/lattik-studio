"use client";

import type { JsonRenderComponentProps } from "../types";

export function Select({ props, state, onStateChange }: JsonRenderComponentProps) {
  const label = props.label as string;
  const field = props.field as string;
  const options = Array.isArray(props.options) ? (props.options as { value: string; label: string }[]) : [];
  const required = props.required as boolean | undefined;

  const value = (state[field] as string) ?? (props.defaultValue as string) ?? "";

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-amber-800">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onStateChange(field, e.target.value)}
        className="rounded-md border border-amber-200/50 bg-white/90 px-2.5 py-1.5 text-xs text-amber-900 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/30"
      >
        <option value="">Select...</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
