"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function CollapsibleContext({ context }: { context: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-white/40 transition-colors hover:text-white/70"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Context
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/30 p-3 text-[11px] text-white/70">
          {JSON.stringify(context, null, 2)}
        </pre>
      )}
    </section>
  );
}
