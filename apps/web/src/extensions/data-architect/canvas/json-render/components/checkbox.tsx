"use client";

import type { JsonRenderComponentProps } from "../types";

export function Checkbox({ props, state, onStateChange }: JsonRenderComponentProps) {
  const label = props.label as string;
  const field = props.field as string;

  const checked = (state[field] as boolean) ?? (props.defaultValue as boolean) ?? false;

  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onStateChange(field, e.target.checked)}
        className="h-3.5 w-3.5 rounded border-amber-300 text-amber-600 focus:ring-amber-400/30"
      />
      <span className="text-xs text-amber-800">{label}</span>
    </label>
  );
}
