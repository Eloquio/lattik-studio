"use client";

import type { JsonRenderComponentProps } from "../types";

export function Section({ props, renderChild }: JsonRenderComponentProps) {
  const title = props.title as string | undefined;
  const children = props.children as string[] | undefined;

  return (
    <div className="flex flex-col gap-3">
      {title && (
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
          {title}
        </h3>
      )}
      <div className="flex flex-col gap-3">
        {children?.map((childId) => (
          <div key={childId}>{renderChild(childId)}</div>
        ))}
      </div>
    </div>
  );
}
