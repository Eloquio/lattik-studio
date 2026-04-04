"use client";

import type { JsonRenderComponentProps } from "../types";

export function Heading({ props }: JsonRenderComponentProps) {
  const title = props.title as string;
  const subtitle = props.subtitle as string | undefined;

  return (
    <div className="mb-2">
      <h2 className="text-lg font-semibold text-amber-900">{title}</h2>
      {subtitle && (
        <p className="mt-0.5 text-sm text-amber-700/60">{subtitle}</p>
      )}
    </div>
  );
}
