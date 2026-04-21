import Link from "next/link";
import { listWorkers } from "@/lib/actions/workers";
import { WorkersClient } from "@/components/workers/workers-client";

export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  const workers = await listWorkers();

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        <div
          className="flex shrink-0 items-center justify-between border-b border-white/10 px-8"
          style={{ height: "49px" }}
        >
          <h1 className="text-sm font-semibold text-white/80">Workers</h1>
          <Link
            href="/"
            className="text-xs text-white/40 transition-colors hover:text-white/70"
          >
            Back to Chat
          </Link>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <WorkersClient initialWorkers={workers} />
        </div>
      </div>
    </div>
  );
}
