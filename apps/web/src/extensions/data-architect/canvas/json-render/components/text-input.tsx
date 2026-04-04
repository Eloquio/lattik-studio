"use client";

import type { JsonRenderComponentProps } from "../types";

export function TextInput({ props, state, onStateChange }: JsonRenderComponentProps) {
  const label = props.label as string;
  const field = props.field as string;
  const placeholder = props.placeholder as string | undefined;
  const required = props.required as boolean | undefined;
  const multiline = props.multiline as boolean | undefined;

  const value = (state[field] as string) ?? (props.defaultValue as string) ?? "";

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-amber-800">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onStateChange(field, e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="rounded-md border border-amber-200/50 bg-white/90 px-2.5 py-1.5 text-xs text-amber-900 placeholder:text-amber-400/60 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/30 resize-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onStateChange(field, e.target.value)}
          placeholder={placeholder}
          className="rounded-md border border-amber-200/50 bg-white/90 px-2.5 py-1.5 text-xs text-amber-900 placeholder:text-amber-400/60 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/30"
        />
      )}
    </div>
  );
}
