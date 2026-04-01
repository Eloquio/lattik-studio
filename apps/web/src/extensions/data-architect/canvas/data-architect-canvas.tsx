"use client";

import type { PipelineDefinition } from "../schema";
import { EntityChip } from "./entity-chip";
import { LoggerTableCard } from "./logger-table-card";
import { LattikTableCard } from "./lattik-table-card";
import { PipelineEmptyState } from "./pipeline-empty-state";

interface CanvasSpec {
  root: string;
  elements: Record<string, { type: string; props: Record<string, unknown> }>;
}

interface DataArchitectCanvasProps {
  state: unknown;
}

function isPipeline(v: unknown): v is PipelineDefinition {
  return typeof v === "object" && v !== null && "version" in v && (v as PipelineDefinition).version === 1;
}

function isCanvasSpec(v: unknown): v is { spec: CanvasSpec } {
  return typeof v === "object" && v !== null && "spec" in v && typeof (v as { spec: unknown }).spec === "object";
}

function CanvasTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-amber-900">{title}</h2>
      {subtitle && <p className="mt-0.5 text-sm text-amber-700/60">{subtitle}</p>}
    </div>
  );
}

function DataTable({ title, columns, rows }: {
  title?: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
}) {
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
                <th key={col.key} className="px-3 py-1.5 text-left font-semibold text-amber-800">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-amber-100/30 last:border-b-0">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-1.5 font-mono text-amber-900/80">
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

function PipelineView({ pipeline }: { pipeline: PipelineDefinition }) {
  return (
    <div className="flex flex-col gap-6">
      {pipeline.entities.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            Entities
          </h3>
          <div className="flex flex-wrap gap-2">
            {pipeline.entities.map((entity) => (
              <EntityChip key={entity.name} entity={entity} />
            ))}
          </div>
        </section>
      )}
      {pipeline.log_tables.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            Logger Tables
          </h3>
          <div className="grid gap-3">
            {pipeline.log_tables.map((table) => (
              <LoggerTableCard key={table.name} table={table} />
            ))}
          </div>
        </section>
      )}
      {pipeline.tables.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-700/60">
            Lattik Tables
          </h3>
          <div className="grid gap-3">
            {pipeline.tables.map((table) => (
              <LattikTableCard key={table.name} table={table} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function renderElement(el: { type: string; props: Record<string, unknown> }) {
  switch (el.type) {
    case "CanvasTitle":
      return <CanvasTitle {...(el.props as { title: string; subtitle?: string })} />;
    case "DataTable":
      return (
        <DataTable
          {...(el.props as {
            title?: string;
            columns: { key: string; label: string }[];
            rows: Record<string, unknown>[];
          })}
        />
      );
    case "PipelineView":
      return <PipelineView pipeline={el.props.pipeline as PipelineDefinition} />;
    default:
      return null;
  }
}

export function DataArchitectCanvas({ state }: DataArchitectCanvasProps) {
  // Canvas spec from renderCanvas tool
  if (isCanvasSpec(state)) {
    const { spec } = state;
    const rootEl = spec.elements[spec.root];
    if (!rootEl) return <PipelineEmptyState />;
    return <div className="flex flex-1 flex-col gap-4 p-5">{renderElement(rootEl)}</div>;
  }

  // Direct pipeline from updatePipeline tool
  if (isPipeline(state)) {
    return (
      <div className="flex flex-1 flex-col p-5">
        <PipelineView pipeline={state} />
      </div>
    );
  }

  return <PipelineEmptyState />;
}
