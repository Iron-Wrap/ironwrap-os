import { Check, CloudOff, Lock, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { AppRole } from "../lib/roles";
import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import {
  canEnterStage,
  classifyMove,
  moveConfirmationPrompt,
  stageById,
} from "./pipeline-board-model";
import type { BoardStage } from "./pipeline-contracts";

/**
 * ONE move menu, three triggers (issue build item 4): the card's visible "Move" button,
 * the touch long-press lift, and a desktop drag whose drop needs a confirm. Every
 * trigger opens this same component and commits through the same callback, so the
 * keyboard path is not a fallback bolted onto a drag implementation — it is the path.
 */
export function MoveMenu({
  cardTitle,
  stages,
  currentStageId,
  role,
  lifted,
  live,
  hoverStageId,
  pendingStageId,
  busy,
  onRequest,
  onConfirm,
  onCancelPending,
  onClose,
}: {
  cardTitle: string;
  stages: readonly BoardStage[];
  currentStageId: string;
  role: AppRole;
  lifted: boolean;
  /**
   * Whether a move can reach the server at all. A move is committed on the server or not
   * at all — it is never queued on this device — so an offline menu says so and offers
   * nothing, the same read-only treatment every configuration surface already gives an
   * offline edit (ELEC-188). Silence here would be the worst place for it: this is the
   * surface where an accidental transition moves a job and money.
   */
  live: boolean;
  hoverStageId: string | null;
  pendingStageId: string | null;
  busy: boolean;
  onRequest: (stage: BoardStage) => void;
  onConfirm: () => void;
  onCancelPending: () => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const currentStage = stageById(stages, currentStageId);
  const pendingStage = pendingStageId ? stageById(stages, pendingStageId) : undefined;

  useEffect(() => {
    if (pendingStageId) {
      listRef.current?.querySelector<HTMLButtonElement>("[data-confirm-move]")?.focus();
      return;
    }
    // Offline every row is disabled, so there is nothing to land the caret on.
    if (!live) return;
    // A lifted card keeps the finger in charge; moving focus under it would fight the
    // gesture. Every other trigger lands the caret on the first stage the user can pick.
    if (lifted) return;
    const first = listRef.current?.querySelector<HTMLButtonElement>(
      "button[data-stage-id]:not(:disabled)",
    );
    first?.focus();
  }, [lifted, live, pendingStageId]);

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-stage-id]:not(:disabled)",
      ) ?? []),
    ];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? (index + 1 + rows.length) % rows.length
            : (index - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  }

  // Portalled to the document body on purpose. `.app-main > *` runs a transform
  // animation, and an ancestor with an animated transform becomes the containing block
  // for `position: fixed` — rendered in place, this overlay would be pinned to the page
  // section instead of the viewport and land mid-board rather than as a bottom sheet.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-foreground/35 sm:items-center"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${cardTitle} to…`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        className="max-h-[min(80dvh,42rem)] w-full overflow-y-auto overscroll-contain rounded-t-xl border border-border bg-surface p-3 shadow-[0_-12px_48px_oklch(0_0_0/0.28)] sm:max-w-md sm:rounded-xl sm:shadow-[0_24px_72px_oklch(0_0_0/0.28)]"
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-1 pb-2">
          <p className="min-w-0 truncate text-sm font-extrabold">Move “{cardTitle}” to…</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close move menu"
            className="grid size-11 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        <p aria-live="polite" className="sr-only">
          {lifted ? `Moving ${cardTitle}. Choose a stage.` : ""}
        </p>

        {!live ? (
          <div className="mt-2">
            <Notice tone="warning" title="Offline — this card cannot be moved">
              A stage change is saved on the server, not on this device, so nothing here is queued.
              The card stays in {currentStage?.name ?? "its stage"} until you reconnect.
            </Notice>
          </div>
        ) : null}

        <div ref={listRef} className="mt-2 space-y-1" onKeyDown={onListKeyDown}>
          {stages.map((stage) => {
            const isCurrent = stage.stage_id === currentStageId;
            const enterable = canEnterStage(role, stage);
            const isPending = stage.stage_id === pendingStageId;
            if (isPending && pendingStage && currentStage) {
              return (
                <div
                  key={stage.stage_id}
                  data-pending-stage-id={stage.stage_id}
                  className="rounded-lg border border-accent/40 bg-surface-muted p-3"
                >
                  <p className="text-sm font-semibold leading-6">
                    {moveConfirmationPrompt(
                      classifyMove(currentStage.position, pendingStage.position),
                      currentStage,
                      pendingStage,
                    )}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button variant="outline" onClick={onCancelPending} disabled={busy}>
                      Cancel
                    </Button>
                    <Button
                      data-confirm-move
                      variant="accent"
                      busy={busy}
                      disabled={!live}
                      onClick={onConfirm}
                    >
                      <Check aria-hidden="true" />
                      Confirm move
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <button
                key={stage.stage_id}
                type="button"
                data-stage-id={stage.stage_id}
                disabled={isCurrent || !enterable || busy || !live}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => onRequest(stage)}
                className={cn(
                  "flex min-h-14 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm font-bold transition-colors",
                  isCurrent
                    ? "bg-surface-muted text-muted"
                    : enterable
                      ? "bg-surface-raised text-foreground hover:bg-surface-muted"
                      : "bg-surface-raised text-muted",
                  hoverStageId === stage.stage_id && "bg-surface-muted ring-2 ring-accent/40",
                )}
              >
                <span className="min-w-0 truncate">
                  {stage.name}
                  {isCurrent ? " (current)" : ""}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs font-bold text-muted">
                  {!live ? <CloudOff className="size-4" aria-label="Offline" /> : null}
                  {!enterable ? <Lock className="size-4" aria-label="Restricted stage" /> : null}
                  <span className="tabular-nums">{stage.card_count ?? 0}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
