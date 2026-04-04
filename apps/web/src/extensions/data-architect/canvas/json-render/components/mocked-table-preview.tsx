"use client";

import type { JsonRenderComponentProps } from "../types";

interface ColumnDef {
  name: string;
  type: string;
}

function generateMockValue(type: string, rowIndex: number): string {
  switch (type) {
    case "int32":
    case "int64":
      return String(1000 + rowIndex * 7 + Math.floor(Math.random() * 100));
    case "float":
    case "double":
      return (Math.random() * 100).toFixed(2);
    case "boolean":
      return rowIndex % 2 === 0 ? "true" : "false";
    case "timestamp":
      return new Date(Date.now() - rowIndex * 86400000).toISOString().slice(0, 19);
    case "date":
      return new Date(Date.now() - rowIndex * 86400000).toISOString().slice(0, 10);
    case "json":
      return "{}";
    case "string":
    default:
      return `value_${rowIndex + 1}`;
  }
}

export function MockedTablePreview({ props }: JsonRenderComponentProps) {
  const title = props.title as string | undefined;
  const columns = (props.columns as ColumnDef[]) ?? [];
  const rowCount = (props.rowCount as number) ?? 3;

  if (columns.length === 0) return null;

  const rows = Array.from({ length: rowCount }, (_, rowIdx) =>
    Object.fromEntries(
      columns.map((col) => [col.name, generateMockValue(col.type, rowIdx)])
    )
  );

  return (
    <div className="overflow-hidden rounded-lg border border-amber-200/50 bg-white/80">
      {title && (
        <div className="border-b border-amber-200/50 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/60">
            {title ?? "Preview"}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-amber-100/50 bg-amber-50/50">
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="px-2.5 py-1 text-left font-semibold text-amber-800"
                >
                  <div>{col.name}</div>
                  <div className="font-normal text-amber-500/60 text-[9px]">
                    {col.type}
                  </div>
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
                    key={col.name}
                    className="px-2.5 py-1 font-mono text-amber-900/60 text-[10px]"
                  >
                    {String(row[col.name])}
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
