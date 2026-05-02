import { NavPanel } from "@/components/layout/nav-panel";
import { WorkersList } from "@/components/workers/workers-list";
import { listWorkers } from "@/lib/actions/workers";

export default async function WorkersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workers = await listWorkers();

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <NavPanel />
      <WorkersList initialWorkers={workers} />

      <div className="relative z-10 flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
