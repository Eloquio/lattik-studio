"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Blocks,
  AlertTriangle,
  BarChart3,
  Brain,
  Database as DatabaseIcon,
  Search,
  Check,
  type LucideIcon,
} from "lucide-react";
import { enableAgent, disableAgent } from "@/lib/actions/agents";

const iconMap: Record<string, LucideIcon> = {
  blocks: Blocks,
  "alert-triangle": AlertTriangle,
  "bar-chart-3": BarChart3,
  brain: Brain,
  database: DatabaseIcon,
  search: Search,
};

interface Agent {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  type: "first-party" | "third-party";
}

interface MarketplaceGridProps {
  agents: Agent[];
  enabledIds: string[];
}

export function MarketplaceGrid({ agents, enabledIds: initialEnabledIds }: MarketplaceGridProps) {
  const [enabledIds, setEnabledIds] = useState(new Set(initialEnabledIds));
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    if (!query.trim()) return agents;
    const q = query.toLowerCase();
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
    );
  }, [agents, query]);

  const enabledAgents = filtered.filter((a) => enabledIds.has(a.id));
  const allAgents = filtered;
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  const handleToggle = (agentId: string) => {
    const isEnabled = enabledIds.has(agentId);
    setError(null);
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (isEnabled) next.delete(agentId);
      else next.add(agentId);
      return next;
    });

    startTransition(async () => {
      try {
        if (isEnabled) await disableAgent(agentId);
        else await enableAgent(agentId);
      } catch {
        setError(`Failed to ${isEnabled ? "disable" : "enable"} agent. Please try again.`);
        setEnabledIds((prev) => {
          const next = new Set(prev);
          if (isEnabled) next.add(agentId);
          else next.delete(agentId);
          return next;
        });
      }
    });
  };

  const Icon = selectedAgent ? (iconMap[selectedAgent.icon] || Blocks) : Blocks;

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm">
      {error && (
        <div className="flex items-center justify-between border-b border-red-500/20 bg-red-500/10 px-4 py-2">
          <span className="text-xs text-red-400">{error}</span>
          <button onClick={() => setError(null)} className="text-xs text-red-400/60 hover:text-red-400">dismiss</button>
        </div>
      )}
      {/* Sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r border-white/10">
        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents..."
              className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-white/30 focus:border-white/20 focus:outline-none"
            />
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {/* Enabled section */}
          {enabledAgents.length > 0 && (
            <div className="mb-3">
              <h3 className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                Enabled
              </h3>
              {enabledAgents.map((agent) => {
                const AgentIcon = iconMap[agent.icon] || Blocks;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedId(agent.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                      selectedId === agent.id
                        ? "bg-white/10 text-white"
                        : "text-white/60 hover:bg-white/5 hover:text-white/80"
                    }`}
                  >
                    <AgentIcon className={`h-4 w-4 shrink-0 ${selectedId === agent.id ? "text-[#e0a96e]" : "text-white/40"}`} />
                    <span className="flex-1 truncate text-xs">{agent.name}</span>
                    <Check className="h-3 w-3 shrink-0 text-[#e0a96e]" />
                  </button>
                );
              })}
            </div>
          )}

          {/* All agents */}
          <div>
            <h3 className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              All Agents
            </h3>
            {allAgents.map((agent) => {
              const AgentIcon = iconMap[agent.icon] || Blocks;
              const isEnabled = enabledIds.has(agent.id);
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedId(agent.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                    selectedId === agent.id
                      ? "bg-white/10 text-white"
                      : "text-white/60 hover:bg-white/5 hover:text-white/80"
                  }`}
                >
                  <AgentIcon className={`h-4 w-4 shrink-0 ${selectedId === agent.id ? "text-[#e0a96e]" : "text-white/40"}`} />
                  <span className="flex-1 truncate text-xs">{agent.name}</span>
                  {isEnabled && <Check className="h-3 w-3 shrink-0 text-[#e0a96e]" />}
                </button>
              );
            })}
            {allAgents.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-white/30">No agents found</p>
            )}
          </div>
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {selectedAgent ? (
          <div className="flex flex-1 flex-col p-8">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/10">
                <Icon className="h-7 w-7 text-[#e0a96e]" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-white">{selectedAgent.name}</h2>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-white/40">{selectedAgent.category}</span>
                  {selectedAgent.type === "first-party" && (
                    <span className="rounded-full bg-[#e0a96e]/15 px-2 py-0.5 text-[10px] font-medium text-[#e0a96e]">
                      Official
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6">
              <button
                onClick={() => handleToggle(selectedAgent.id)}
                className={`rounded-lg px-6 py-3 text-sm font-semibold transition-colors ${
                  enabledIds.has(selectedAgent.id)
                    ? "border border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                    : "bg-[#e0a96e] text-black hover:bg-[#d4993e]"
                }`}
              >
                {enabledIds.has(selectedAgent.id) ? "Disable Agent" : "Enable Agent"}
              </button>
            </div>

            <p className="mt-6 text-sm leading-relaxed text-white/50">
              {selectedAgent.description}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-white/30">
            Select an agent to view details
          </div>
        )}
      </div>
    </div>
  );
}
