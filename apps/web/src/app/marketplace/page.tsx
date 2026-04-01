import { listAgents, getUserEnabledAgentIds } from "@/lib/actions/agents";
import { MarketplaceGrid } from "@/components/marketplace/marketplace-grid";

export default async function MarketplacePage() {
  const [agents, enabledIds] = await Promise.all([
    listAgents(),
    getUserEnabledAgentIds(),
  ]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      {/* Background image + blur */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      {/* Content */}
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-8" style={{ height: "49px" }}>
          <h1 className="text-sm font-semibold text-white/80">Agent Marketplace</h1>
          <a
            href="/"
            className="text-xs text-white/40 transition-colors hover:text-white/70"
          >
            Back to Chat
          </a>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-hidden p-6">
          <MarketplaceGrid
            agents={agents}
            enabledIds={Array.from(enabledIds)}
          />
        </div>
      </div>
    </div>
  );
}
