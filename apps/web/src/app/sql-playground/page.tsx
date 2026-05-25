import { Terminal } from "lucide-react";
import { NavPanel } from "@/components/layout/nav-panel";

export const dynamic = "force-dynamic";

export default function SqlPlaygroundPage() {
  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <NavPanel />
      <main className="canvas-paper relative z-10 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-8">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-stone-800">
              SQL Playground
            </h2>
          </div>
          <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-12 text-center">
            <p className="text-xs text-stone-500">Coming soon.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
