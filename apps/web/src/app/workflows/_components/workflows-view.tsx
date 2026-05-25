"use client";

import { Activity } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { WorkflowRunCard, type StepChain } from "./workflow-run-card";
import { StepDetailPanel, type StepDetail } from "./step-detail-panel";

export interface RunCardData {
  id: string;
  workflowName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  prUrl: string | null;
  added: string[];
  modified: string[];
  deleted: string[];
  invalid: string[];
  stepChains: StepChain[];
}

interface WorkflowsViewProps {
  cards: RunCardData[];
  /** stepId → full step record for the side panel. */
  stepDetails: Record<string, StepDetail>;
  activeCount: number;
  succeededCount: number;
  failedCount: number;
}

const DEFAULT_PANEL_WIDTH = 40;

export function WorkflowsView({
  cards,
  stepDetails,
  activeCount,
  succeededCount,
  failedCount,
}: WorkflowsViewProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);

  const selectedStep = useMemo(
    () => (selectedStepId ? stepDetails[selectedStepId] ?? null : null),
    [selectedStepId, stepDetails],
  );

  const handleStepClick = useCallback((stepId: string) => {
    setSelectedStepId((prev) => (prev === stepId ? null : stepId));
  }, []);

  const handleClose = useCallback(() => {
    setSelectedStepId(null);
  }, []);

  return (
    <>
      <main className="canvas-paper relative z-10 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-8">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-600" />
              <h2 className="text-sm font-semibold text-stone-800">Workflows</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1">
                <span className="text-[11px] font-medium text-stone-500">
                  {cards.length} recent
                </span>
              </div>
              {activeCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  <span className="text-[11px] font-medium text-blue-700">
                    {activeCount} running
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-medium text-emerald-700">
                  {succeededCount} succeeded
                </span>
              </div>
              {failedCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span className="text-[11px] font-medium text-red-700">
                    {failedCount} failed
                  </span>
                </div>
              )}
            </div>
          </div>

          {cards.length === 0 ? (
            <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-12 text-center">
              <p className="text-xs text-stone-500">
                No workflow runs yet. Merge a pipeline PR to trigger one.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {cards.map((card) => (
                <WorkflowRunCard
                  key={card.id}
                  workflowName={card.workflowName}
                  status={card.status}
                  startedAt={card.startedAt}
                  finishedAt={card.finishedAt}
                  errorMessage={card.errorMessage}
                  prUrl={card.prUrl}
                  added={card.added}
                  modified={card.modified}
                  deleted={card.deleted}
                  invalid={card.invalid}
                  stepChains={card.stepChains}
                  onStepClick={handleStepClick}
                  selectedStepId={selectedStepId}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <StepDetailPanel
        step={selectedStep}
        width={panelWidth}
        onWidthChange={setPanelWidth}
        onClose={handleClose}
      />
    </>
  );
}
