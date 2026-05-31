"use client";

import { Activity } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkflowRunCard, type StepChain } from "./workflow-run-card";
import { StepDetailPanel, type StepDetail } from "./step-detail-panel";
import {
  parseOpenParam,
  serializeOpenParam,
  toggleOpenRun,
} from "./open-run-state";

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
  // Persist UI state in URL query params so refresh / share-by-URL
  // restores the view: `?step=<id>` for the side-panel selection,
  // `?open=<id>` for the single expanded run card (accordion). Initial
  // values are read once on mount; subsequent transitions update the
  // URL via history.replaceState so we don't trigger a Next server
  // re-fetch on every click.
  const searchParams = useSearchParams();
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    () => searchParams.get("step"),
  );
  const [openRunIds, setOpenRunIds] = useState<Set<string>>(() =>
    parseOpenParam(searchParams.get("open")),
  );
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);

  const selectedStep = useMemo(
    () => (selectedStepId ? stepDetails[selectedStepId] ?? null : null),
    [selectedStepId, stepDetails],
  );

  const syncSearchParam = useCallback(
    (key: string, value: string | null) => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (value) {
        url.searchParams.set(key, value);
      } else {
        url.searchParams.delete(key);
      }
      window.history.replaceState(null, "", url.toString());
    },
    [],
  );

  const handleStepClick = useCallback(
    (stepId: string) => {
      setSelectedStepId((prev) => {
        const next = prev === stepId ? null : stepId;
        syncSearchParam("step", next);
        return next;
      });
    },
    [syncSearchParam],
  );

  const handleClose = useCallback(() => {
    setSelectedStepId(null);
    syncSearchParam("step", null);
  }, [syncSearchParam]);

  const handleToggleOpen = useCallback(
    (runId: string) => {
      setOpenRunIds((prev) => {
        const next = toggleOpenRun(prev, runId);
        syncSearchParam("open", serializeOpenParam(next));
        return next;
      });
    },
    [syncSearchParam],
  );

  useEffect(() => {
    if (!selectedStep) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedStep, handleClose]);

  // If we hydrated with a `?step=<id>` that no longer exists (stale
  // share link, deleted step), drop the param so the URL doesn't
  // carry a phantom selection.
  useEffect(() => {
    if (selectedStepId && !stepDetails[selectedStepId]) {
      setSelectedStepId(null);
      syncSearchParam("step", null);
    }
  }, [selectedStepId, stepDetails, syncSearchParam]);

  // Drop any `?open=...` ids that don't match a currently-visible run
  // (the 100-row window scrolled past, or the row was deleted). Keeps
  // the URL honest after a refresh.
  useEffect(() => {
    const visibleIds = new Set(cards.map((c) => c.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of openRunIds) {
      if (visibleIds.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setOpenRunIds(next);
      syncSearchParam("open", serializeOpenParam(next));
    }
  }, [cards, openRunIds, syncSearchParam]);

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
      {/* Left half — workflow runs list. When the panel is open we
          drop the max-width constraint and tighten the inside edge
          so the cards hug the splitter instead of leaving a wide
          empty gutter; when the panel is closed, fall back to the
          centered max-w-5xl layout. */}
      <div className="flex-1 overflow-auto">
        <div
          className={
            selectedStep
              ? "flex flex-col gap-4 py-8 pl-8 pr-4"
              : "mx-auto flex max-w-5xl flex-col gap-4 p-8"
          }
        >
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
                  isOpen={openRunIds.has(card.id)}
                  onToggle={() => handleToggleOpen(card.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedStep && (
        <>
          {/* Splitter — invisible by default so the notebook surface
              reads as one continuous page. Hover/drag reveals a thin
              line so the resize affordance stays discoverable. */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleSplitterMouseDown}
            className="group relative flex h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-px bg-transparent transition-colors group-hover:bg-stone-400/60 group-active:bg-stone-500/80" />
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
