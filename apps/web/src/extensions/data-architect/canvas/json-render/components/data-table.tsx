"use client";

import type { JsonRenderComponentProps } from "../types";

export function DataTable({ props }: JsonRenderComponentProps) {
  const title = props.title as string | undefined;
  const columns = props.columns as { key: string; label: string }[];
  const rows = props.rows as Record<string, unknown>[];

  return (
    <div className="overflow-hidden rounded-lg border border-amber-200/50 bg-white/80">
      {title && (
        <div className="border-b border-amber-200/50 px-3 py-2">
          <span className="text-xs font-semibold text-amber-900">{title}</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-amber-100/50 bg-amber-50/50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-1.5 text-left font-semibold text-amber-800"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-amber-100/30 last:border-b-0"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-1.5 font-mono text-amber-900/80"
                  >
                    {String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
