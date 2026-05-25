"use client";

import { Activity } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Splitter sits 50/50 by default; the user can drag it 25–75. The
 * panel side reads the percentage out of the total available width,
 * matching how the chat canvas computes its split.
 */
const DEFAULT_PANEL_WIDTH = 50;
const NAV_WIDTH = 56;

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

  useEffect(() => {
    if (!selectedStep) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedStep, handleClose]);

  const isDragging = useRef(false);
  const handlersRef = useRef<{
    move: ((e: MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  useEffect(() => {
    return () => {
      if (handlersRef.current.move) {
        document.removeEventListener("mousemove", handlersRef.current.move);
      }
      if (handlersRef.current.up) {
        document.removeEventListener("mouseup", handlersRef.current.up);
      }
    };
  }, []);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const windowWidth = window.innerWidth;
      const availableWidth = windowWidth - NAV_WIDTH;
      const newWidth =
        ((windowWidth - ev.clientX) / availableWidth) * 100;
      setPanelWidth(Math.min(Math.max(newWidth, 25), 75));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      handlersRef.current = { move: null, up: null };
    };

    if (handlersRef.current.move) {
      document.removeEventListener("mousemove", handlersRef.current.move);
    }
    if (handlersRef.current.up) {
      document.removeEventListener("mouseup", handlersRef.current.up);
    }

    handlersRef.current = { move: handleMouseMove, up: handleMouseUp };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  return (
    <main className="canvas-paper relative z-10 flex flex-1 overflow-hidden">
      {/* Left half — workflow runs list. */}
      <div className="flex-1 overflow-auto">
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
      </div>

      {selectedStep && (
        <>
          {/* Splitter sits at the seam on the same canvas-paper surface.
              Grab zone is wider than the visible divider for easier
              dragging. */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleSplitterMouseDown}
            className="group relative flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-px bg-stone-400/60 transition-colors group-hover:bg-stone-500/80 group-active:bg-stone-600" />
          </div>

          {/* Right half — step detail. No own background so it reads as
              the same notebook page. */}
          <div
            className="shrink-0 overflow-auto"
            style={{ width: `${panelWidth}%` }}
          >
            <StepDetailPanel step={selectedStep} onClose={handleClose} />
          </div>
        </>
      )}
    </main>
  );
}
