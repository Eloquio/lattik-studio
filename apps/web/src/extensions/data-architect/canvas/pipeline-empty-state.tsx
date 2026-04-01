"use client";

import { Blocks, Database, Table2 } from "lucide-react";

export function PipelineEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-amber-900/60">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-200/50">
          <Blocks className="h-6 w-6 text-amber-700" />
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-200/50">
          <Database className="h-6 w-6 text-amber-700" />
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-200/50">
          <Table2 className="h-6 w-6 text-amber-700" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-amber-900/70">No pipeline yet</p>
        <p className="mt-1 text-xs text-amber-800/50">
          Start designing your pipeline in the chat
        </p>
      </div>
    </div>
  );
}
