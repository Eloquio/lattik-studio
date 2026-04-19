import { NavPanel } from "@/components/layout/nav-panel";
import { RequestsList } from "@/components/requests/requests-list";
import { listAllRequests } from "@/lib/actions/requests";

export default async function RequestsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requests = await listAllRequests();

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <NavPanel />
      <RequestsList requests={requests} />

      <div className="relative z-10 flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
