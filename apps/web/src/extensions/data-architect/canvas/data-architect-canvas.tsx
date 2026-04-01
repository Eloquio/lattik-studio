"use client";

import type { PipelineDefinition } from "../schema";
import { EntityChip } from "./entity-chip";
import { LoggerTableCard } from "./logger-table-card";
import { LattikTableCard } from "./lattik-table-card";
import { PipelineEmptyState } from "./pipeline-empty-state";

interface DataArchitectCanvasProps {
  state: unknown;
}

function isPipeline(state: unknown): state is PipelineDefinition {
  return (
    typeof state === "object" &&
    state !== null &&
    "version" in state &&
    (state as PipelineDefinition).version === 1
  );
}

export function DataArchitectCanvas({ state }: DataArchitectCanvasProps) {
  if (!isPipeline(state)) {
    return <PipelineEmptyState />;
  }

  const { entities, log_tables, tables } = state;

  return (
    <div className="flex flex-1 flex-col gap-6 p-5">
      {/* Entities */}
      {entities.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            Entities
          </h3>
          <div className="flex flex-wrap gap-2">
            {entities.map((entity) => (
              <EntityChip key={entity.name} entity={entity} />
            ))}
          </div>
        </section>
      )}

      {/* Logger Tables */}
      {log_tables.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700/60">
            Logger Tables
          </h3>
          <div className="grid gap-3">
            {log_tables.map((table) => (
              <LoggerTableCard key={table.name} table={table} />
            ))}
          </div>
        </section>
      )}

      {/* Lattik Tables */}
      {tables.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-700/60">
            Lattik Tables
          </h3>
          <div className="grid gap-3">
            {tables.map((table) => (
              <LattikTableCard key={table.name} table={table} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
