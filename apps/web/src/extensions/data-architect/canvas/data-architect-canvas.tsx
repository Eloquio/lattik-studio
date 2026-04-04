"use client";

import type { PipelineDefinition } from "../schema";
import { EntityChip } from "./entity-chip";
import { LoggerTableCard } from "./logger-table-card";
import { LattikTableCard } from "./lattik-table-card";
import { PipelineEmptyState } from "./pipeline-empty-state";
import { JsonRenderer, type RenderSpec } from "./json-render";

interface DataArchitectCanvasProps {
  state: unknown;
  onStateChange?: (state: Record<string, unknown>) => void;
}

function isPipeline(v: unknown): v is PipelineDefinition {
  return typeof v === "object" && v !== null && "version" in v && (v as PipelineDefinition).version === 1;
}

function isRenderSpec(v: unknown): v is { spec: RenderSpec } {
  return (
    typeof v === "object" &&
    v !== null &&
    "spec" in v &&
    typeof (v as { spec: unknown }).spec === "object" &&
    (v as { spec: { root?: unknown } }).spec !== null &&
    "root" in ((v as { spec: { root?: unknown } }).spec)
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

export function DataArchitectCanvas({ state, onStateChange }: DataArchitectCanvasProps) {
  // json-render spec from renderCanvas tool
  if (isRenderSpec(state)) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-5">
        <JsonRenderer spec={(state as { spec: RenderSpec }).spec} onStateChange={onStateChange} />
      </div>
    );
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
