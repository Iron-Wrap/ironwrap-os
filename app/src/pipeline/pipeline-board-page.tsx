import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { KanbanSquare, RefreshCw, Undo2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { EmptyState, ErrorState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import type { AppRole } from "../lib/roles";
import { MoveMenu } from "./move-menu";
import {
  applyOptimisticMove,
  canEnterStage,
  canMoveCards,
  cardsInStage,
  classifyMove,
  DRAG_START_DISTANCE_PX,
  LONG_PRESS_MS,
  moveNeedsConfirmation,
  orderedStages,
  stageById,
  stageRollUp,
  UNDO_WINDOW_MS,
} from "./pipeline-board-model";
import {
  loadPipelineBoard,
  loadPipelines,
  moveCardToStage,
  newCardMoveKey,
  newCardMoveUndoKey,
  undoCardMove,
} from "./pipeline-api";
import { PipelineCard } from "./pipeline-card";
import type { BoardCard, BoardStage, PipelineBoardResponse } from "./pipeline-contracts";

/**
 * The pipeline board, mounted once per role app rather than as one shared `/pipelines`
 * route with role filtering inside it (UX spec section 4). Sales reaches its own
 * pipeline at `/sales/board`; Owner and Operations reach every pipeline, with a
 * switcher, at `/owner/board`. Production, Accounting and Field get no board in M1
 * (PO decision D10, UX spec section 4).
 */
export function SalesPipelineBoardPage() {
  return (
    <RoleGuard surface="sales">
      <PipelineBoardScreen scope="owned" />
    </RoleGuard>
  );
}

export function OwnerPipelineBoardPage() {
  return (
    <RoleGuard surface="owner">
      <PipelineBoardScreen scope="all" />
    </RoleGuard>
  );
}

type BoardToast = {
  id: number;
  tone: "success" | "error";
  message: string;
  undo?: { cardId: string; transitionId: string; fromStageId: string };
};

type MoveMenuState = { cardId: string; lifted: boolean; pendingStageId: string | null };

type MoveVariables = { cardId: string; toStageId: string; confirmed: boolean };

function PipelineBoardScreen({ scope }: { scope: "all" | "owned" }) {
  const session = useSession();
  const role = session.user.role;
  const queryClient = useQueryClient();

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines", session.tenant.id, session.user.id],
    queryFn: () => loadPipelines(),
  });

  const pipelines = useMemo(() => pipelinesQuery.data?.pipelines ?? [], [pipelinesQuery.data]);
  const visiblePipelines = useMemo(() => {
    if (scope === "all") return pipelines;
    // Role scoping is `pipelines.owning_role` in M1 (PO decision D8) — no board key is
    // hardcoded here, so a second Sales-owned pipeline needs no client change.
    return pipelines.filter((pipeline) => pipeline.owning_role === role);
  }, [pipelines, role, scope]);

  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const activePipeline =
    visiblePipelines.find((pipeline) => pipeline.pipeline_id === selectedPipelineId) ??
    visiblePipelines[0];

  const boardKey = ["pipeline-board", session.tenant.id, activePipeline?.pipeline_id ?? "none"];
  const boardQuery = useQuery({
    queryKey: boardKey,
    queryFn: () => loadPipelineBoard(activePipeline?.pipeline_id ?? ""),
    enabled: Boolean(activePipeline),
  });

  const board = boardQuery.data;
  const stages = useMemo(() => orderedStages(board?.stages ?? []), [board?.stages]);
  const movePermitted = canMoveCards(board?.allowed_actions ?? []);
  // The stage counts are the pipeline's true size; `cards.length` is only what this
  // payload carried, so summing the columns keeps the header and the columns agreeing.
  const boardCardCount = stages.reduce((total, item) => total + (item.card_count ?? 0), 0);

  const [toast, setToast] = useState<BoardToast | null>(null);
  const [moveMenu, setMoveMenu] = useState<MoveMenuState | null>(null);
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);
  const [sheetHoverStageId, setSheetHoverStageId] = useState<string | null>(null);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);

  const moveKeys = useRef(new Map<string, string>());
  const toastId = useRef(0);

  const showToast = useCallback((next: Omit<BoardToast, "id">) => {
    toastId.current += 1;
    setToast({ ...next, id: toastId.current });
  }, []);

  // The success toast carries the Undo affordance for exactly this window (PO decision
  // D1). The server keeps accepting an undo for longer; the UI never offers a button
  // that could outlive the server's answer.
  useEffect(() => {
    if (!toast || toast.tone !== "success") return;
    const timer = window.setTimeout(() => setToast(null), UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const moveMutation = useMutation({
    retry: false,
    mutationFn: async (variables: MoveVariables) => {
      if (!activePipeline) throw new Error("pipeline_unavailable");
      const card = board?.cards.find((candidate) => candidate.card_id === variables.cardId);
      const mapKey = `${variables.cardId}:${variables.toStageId}`;
      // Same idempotency key across the `confirmation_required` round trip: the confirm
      // is the same command, not a second one (ELEC-155 section 4).
      const idempotencyKey = moveKeys.current.get(mapKey) ?? newCardMoveKey();
      moveKeys.current.set(mapKey, idempotencyKey);
      return await moveCardToStage(
        session,
        {
          pipelineId: activePipeline.pipeline_id,
          cardId: variables.cardId,
          toStageId: variables.toStageId,
          expectedVersion: card?.version,
          confirmed: variables.confirmed,
        },
        idempotencyKey,
      );
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: boardKey });
      const previous = queryClient.getQueryData<PipelineBoardResponse>(boardKey);
      const fromStageId = previous?.cards.find(
        (card) => card.card_id === variables.cardId,
      )?.stage_id;
      if (previous) {
        queryClient.setQueryData(
          boardKey,
          applyOptimisticMove(previous, variables.cardId, variables.toStageId),
        );
      }
      return { previous, fromStageId };
    },
    onError: (error, variables, context) => {
      // The server is the authority; the optimistic update was only a fast guess.
      if (context?.previous) queryClient.setQueryData(boardKey, context.previous);
      handleMoveError(error, variables);
    },
    onSuccess: (response, variables, context) => {
      moveKeys.current.delete(`${variables.cardId}:${variables.toStageId}`);
      setMoveMenu(null);
      const stageName = stageById(stages, variables.toStageId)?.name ?? "the next stage";
      const transitionId =
        typeof response.transition_id === "string" ? response.transition_id : undefined;
      showToast({
        tone: "success",
        message: `Moved to ${stageName}`,
        undo:
          transitionId && context?.fromStageId
            ? {
                cardId: variables.cardId,
                transitionId,
                fromStageId: context.fromStageId,
              }
            : undefined,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
    },
  });

  const undoMutation = useMutation({
    retry: false,
    mutationFn: async (variables: {
      cardId: string;
      transitionId: string;
      fromStageId: string;
    }) => {
      if (!activePipeline) throw new Error("pipeline_unavailable");
      return await undoCardMove(
        session,
        {
          pipelineId: activePipeline.pipeline_id,
          cardId: variables.cardId,
          transitionId: variables.transitionId,
        },
        newCardMoveUndoKey(),
      );
    },
    onMutate: async (variables) => {
      setToast(null);
      await queryClient.cancelQueries({ queryKey: boardKey });
      const previous = queryClient.getQueryData<PipelineBoardResponse>(boardKey);
      if (previous) {
        queryClient.setQueryData(
          boardKey,
          applyOptimisticMove(previous, variables.cardId, variables.fromStageId),
        );
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(boardKey, context.previous);
      showToast({
        tone: "error",
        message: messageForError(error, "The move could not be undone."),
      });
    },
    onSuccess: (_response, variables) => {
      const stageName = stageById(stages, variables.fromStageId)?.name ?? "its previous stage";
      showToast({ tone: "success", message: `Move undone. Card is back in ${stageName}.` });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
    },
  });

  function handleMoveError(error: unknown, variables: MoveVariables) {
    if (error instanceof ApiError && error.code === "confirmation_required") {
      // The server asked for the confirm this client thought it could skip. Surface the
      // same confirm step rather than failing the move: the rule stays server-owned.
      setMoveMenu({ cardId: variables.cardId, lifted: false, pendingStageId: variables.toStageId });
      return;
    }
    if (
      error instanceof ApiError &&
      (error.code === "stage_entry_role_required" || error.status === 403)
    ) {
      setMoveMenu(null);
      showToast({
        tone: "error",
        message: "Your role cannot move a card into that stage. The card stayed where it was.",
      });
      return;
    }
    if (error instanceof ApiError && error.status === 409) {
      setMoveMenu(null);
      showToast({
        tone: "error",
        message: "Someone else changed this card first. The board has been refreshed.",
      });
      return;
    }
    setMoveMenu(null);
    showToast({ tone: "error", message: messageForError(error, "The card stayed where it was.") });
  }

  const requestMove = useCallback(
    (card: BoardCard, targetStage: BoardStage, keepMenuOpen: boolean) => {
      const fromStage = stageById(stages, card.stage_id);
      if (!fromStage || targetStage.stage_id === card.stage_id) return;
      if (!canEnterStage(role, targetStage)) {
        showToast({
          tone: "error",
          message: `${targetStage.name} is restricted to ${targetStage.min_role_to_enter}.`,
        });
        return;
      }
      const kind = classifyMove(fromStage.position, targetStage.position);
      if (moveNeedsConfirmation(kind, targetStage)) {
        setMoveMenu({ cardId: card.card_id, lifted: false, pendingStageId: targetStage.stage_id });
        return;
      }
      if (!keepMenuOpen) setMoveMenu(null);
      moveMutation.mutate({
        cardId: card.card_id,
        toStageId: targetStage.stage_id,
        confirmed: false,
      });
    },
    [moveMutation, role, showToast, stages],
  );

  // ---- Pointer gestures: desktop drag and touch long-press, one commit path --------

  const gesture = useRef<{
    pointerId: number;
    cardId: string;
    startX: number;
    startY: number;
    timer: number | null;
    mode: "press" | "drag" | "sheet";
  } | null>(null);

  const endGesture = useCallback(() => {
    const current = gesture.current;
    if (current?.timer !== null && current?.timer !== undefined) window.clearTimeout(current.timer);
    gesture.current = null;
    setDragCardId(null);
    setDragOverStageId(null);
    setSheetHoverStageId(null);
  }, []);

  const stageIdAtPoint = useCallback((x: number, y: number, selector: string): string | null => {
    if (typeof document.elementFromPoint !== "function") return null;
    const element = document.elementFromPoint(x, y);
    const container = element?.closest(selector);
    return container?.getAttribute("data-stage-id") ?? null;
  }, []);

  useEffect(() => {
    if (!movePermitted) return;

    function onPointerMove(event: PointerEvent) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);

      if (current.mode === "press") {
        if (distance <= DRAG_START_DISTANCE_PX) return;
        if (event.pointerType === "mouse") {
          current.mode = "drag";
          setDragCardId(current.cardId);
        } else {
          // A finger that travels before the long-press fires is scrolling the board,
          // not lifting a card.
          if (current.timer !== null) window.clearTimeout(current.timer);
          gesture.current = null;
        }
        return;
      }
      if (current.mode === "drag") {
        setDragOverStageId(stageIdAtPoint(event.clientX, event.clientY, "[data-stage-column]"));
        return;
      }
      setSheetHoverStageId(stageIdAtPoint(event.clientX, event.clientY, "button[data-stage-id]"));
    }

    function onPointerUp(event: PointerEvent) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const card = board?.cards.find((candidate) => candidate.card_id === current.cardId);
      const targetStageId =
        current.mode === "drag"
          ? stageIdAtPoint(event.clientX, event.clientY, "[data-stage-column]")
          : current.mode === "sheet"
            ? stageIdAtPoint(event.clientX, event.clientY, "button[data-stage-id]")
            : null;
      const mode = current.mode;
      endGesture();
      // Releasing a lifted card away from a stage row is a cancel (UX spec section 3).
      if (mode === "sheet" && !targetStageId) setMoveMenu(null);
      if (!card || !targetStageId) return;
      const targetStage = stageById(stages, targetStageId);
      if (targetStage) requestMove(card, targetStage, mode === "sheet");
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", endGesture);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", endGesture);
    };
  }, [board?.cards, endGesture, movePermitted, requestMove, stageIdAtPoint, stages]);

  function onCardPointerDown(event: ReactPointerEvent<HTMLElement>, card: BoardCard) {
    if (!movePermitted || moveMenu) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The card's own controls stay clickable; only its body is a drag handle.
    if ((event.target as Element).closest("button, a, input")) return;

    const started: NonNullable<typeof gesture.current> = {
      pointerId: event.pointerId,
      cardId: card.card_id,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      mode: "press",
    };
    gesture.current = started;

    if (event.pointerType !== "mouse") {
      started.timer = window.setTimeout(() => {
        if (gesture.current !== started) return;
        started.mode = "sheet";
        started.timer = null;
        setDragCardId(card.card_id);
        setMoveMenu({ cardId: card.card_id, lifted: true, pendingStageId: null });
      }, LONG_PRESS_MS);
    }
  }

  // ---- Stage pager -----------------------------------------------------------------

  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<string, HTMLElement>());

  // Derived, not stored: before the first horizontal scroll the pager sits on the first
  // stage, and storing that in an effect would be a cascading render for no gain.
  const pagedStageId = activeStageId ?? stages[0]?.stage_id ?? null;

  function syncActiveStage() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let nearest: { id: string; distance: number } | null = null;
    for (const [stageId, element] of columnRefs.current) {
      const distance = Math.abs(element.offsetLeft - scroller.scrollLeft);
      if (!nearest || distance < nearest.distance) nearest = { id: stageId, distance };
    }
    if (nearest) setActiveStageId(nearest.id);
  }

  function showStage(stageId: string) {
    setActiveStageId(stageId);
    const column = columnRefs.current.get(stageId);
    column?.scrollIntoView?.({ behavior: "smooth", inline: "start", block: "nearest" });
  }

  // ---- Render ----------------------------------------------------------------------

  if (pipelinesQuery.isPending) return <BoardSkeleton />;
  if (pipelinesQuery.isError) {
    return (
      <ErrorState
        message="The pipeline list did not load. Your saved work is untouched."
        onRetry={() => void pipelinesQuery.refetch()}
      />
    );
  }
  if (!activePipeline) {
    return (
      <EmptyState
        title="No pipeline yet"
        message="No pipeline has been set up for your role. An administrator adds one in Settings."
      />
    );
  }

  const activeCard = moveMenu
    ? board?.cards.find((candidate) => candidate.card_id === moveMenu.cardId)
    : undefined;

  return (
    <section className="mx-auto max-w-[100rem] space-y-4 pb-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-foreground text-background">
            <KanbanSquare className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-black tracking-[-0.03em] sm:text-2xl lg:text-3xl">
              {activePipeline.name}
            </h1>
            <p className="text-xs font-semibold text-muted sm:text-sm">
              {board ? `${boardCardCount} cards · ${stages.length} stages` : "Loading the board…"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {scope === "all" && visiblePipelines.length > 1 ? (
            <label className="flex items-center gap-2 text-sm font-bold text-muted">
              <span className="sr-only sm:not-sr-only">Pipeline</span>
              <select
                value={activePipeline.pipeline_id}
                onChange={(event) => setSelectedPipelineId(event.target.value)}
                className="min-h-11 rounded-md border border-border bg-surface-raised px-3 text-sm font-bold text-foreground"
              >
                {visiblePipelines.map((pipeline) => (
                  <option key={pipeline.pipeline_id} value={pipeline.pipeline_id}>
                    {pipeline.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button
            variant="outline"
            size="compact"
            aria-label="Refresh the board"
            onClick={() => void boardQuery.refetch()}
            busy={boardQuery.isFetching}
          >
            <RefreshCw aria-hidden="true" />
            {/* The label is dropped, not visually hidden, on a phone: the board's own
                vertical space is the scarce thing there. */}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </header>

      {board && !movePermitted ? (
        <Notice tone="info" title="Read only">
          You can read this board. Moving a card between stages needs the move permission for this
          pipeline — ask the office to change your role.
        </Notice>
      ) : null}

      {boardQuery.isError && !board ? (
        <ErrorState
          message="The board did not load. Nothing on it was changed."
          onRetry={() => void boardQuery.refetch()}
        />
      ) : null}

      {stages.length > 0 ? (
        <div
          className="sticky top-14 z-30 -mx-4 flex gap-1 overflow-x-auto border-b border-border bg-surface px-4 py-2 sm:-mx-6 sm:px-6 lg:hidden"
          aria-label="Stages"
        >
          {stages.map((stage) => (
            <button
              key={stage.stage_id}
              type="button"
              aria-pressed={pagedStageId === stage.stage_id}
              onClick={() => showStage(stage.stage_id)}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-bold transition-colors",
                pagedStageId === stage.stage_id
                  ? "bg-foreground text-background"
                  : "bg-surface-muted text-muted",
              )}
            >
              <span>{stage.name}</span>
              <span className="tabular-nums">{stage.card_count ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      {!board && boardQuery.isPending ? (
        <BoardSkeleton />
      ) : (
        <div
          ref={scrollerRef}
          onScroll={syncActiveStage}
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 lg:snap-none"
        >
          {stages.map((stage) => (
            <StageColumn
              key={stage.stage_id}
              stage={stage}
              cards={cardsInStage(board?.cards ?? [], stage.stage_id)}
              template={board?.pipeline.card_template_json}
              locale={session.tenant.locale}
              currency={session.tenant.currency}
              role={role}
              movePermitted={movePermitted}
              dragCardId={dragCardId}
              dragOver={dragOverStageId === stage.stage_id}
              onRegister={(element) => {
                if (element) columnRefs.current.set(stage.stage_id, element);
                else columnRefs.current.delete(stage.stage_id);
              }}
              onMove={(card) =>
                setMoveMenu({ cardId: card.card_id, lifted: false, pendingStageId: null })
              }
              onCardPointerDown={onCardPointerDown}
            />
          ))}
        </div>
      )}

      {moveMenu && activeCard ? (
        <MoveMenu
          cardTitle={activeCard.summary.title}
          stages={stages}
          currentStageId={activeCard.stage_id}
          role={role}
          lifted={moveMenu.lifted}
          hoverStageId={sheetHoverStageId}
          pendingStageId={moveMenu.pendingStageId}
          busy={moveMutation.isPending}
          onRequest={(stage) => requestMove(activeCard, stage, true)}
          onConfirm={() => {
            if (!moveMenu.pendingStageId) return;
            moveMutation.mutate({
              cardId: activeCard.card_id,
              toStageId: moveMenu.pendingStageId,
              confirmed: true,
            });
          }}
          onCancelPending={() => setMoveMenu({ ...moveMenu, pendingStageId: null })}
          onClose={() => setMoveMenu(null)}
        />
      ) : null}

      <MoveToast
        toast={toast}
        busy={undoMutation.isPending}
        onUndo={(undo) => undoMutation.mutate(undo)}
        onDismiss={() => setToast(null)}
      />
    </section>
  );
}

function StageColumn({
  stage,
  cards,
  template,
  locale,
  currency,
  role,
  movePermitted,
  dragCardId,
  dragOver,
  onRegister,
  onMove,
  onCardPointerDown,
}: {
  stage: BoardStage;
  cards: BoardCard[];
  template: PipelineBoardResponse["pipeline"]["card_template_json"];
  locale: string;
  currency: string;
  role: AppRole;
  movePermitted: boolean;
  dragCardId: string | null;
  dragOver: boolean;
  onRegister: (element: HTMLElement | null) => void;
  onMove: (card: BoardCard) => void;
  onCardPointerDown: (event: ReactPointerEvent<HTMLElement>, card: BoardCard) => void;
}) {
  const rollUp = stageRollUp(stage, locale, currency);
  const enterable = canEnterStage(role, stage);
  return (
    <section
      ref={onRegister}
      data-stage-column=""
      data-stage-id={stage.stage_id}
      aria-label={`${stage.name} column`}
      className={cn(
        // `relative` on purpose: it makes the column the containing block for any
        // absolutely positioned descendant, so nothing inside a scrolled-off column
        // can widen the page itself.
        "relative flex max-h-[65dvh] w-full shrink-0 snap-start flex-col rounded-lg border border-border bg-surface transition-[box-shadow] duration-[var(--motion-fast)] sm:w-[85vw] lg:max-h-[calc(100dvh-17rem)] lg:w-[16.5rem]",
        dragOver && enterable && "ring-2 ring-accent/40",
        dragOver && !enterable && "ring-2 ring-danger/40",
      )}
    >
      <header className="flex min-h-16 shrink-0 flex-col justify-center gap-0.5 rounded-t-lg border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-extrabold">{stage.name}</h3>
          {stage.is_won ? (
            <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-bold text-ok">
              WON
            </span>
          ) : null}
          <span className="shrink-0 rounded-full bg-surface-muted px-2 text-xs font-bold tabular-nums">
            {stage.card_count ?? 0}
          </span>
        </div>
        <p className="text-sm font-bold tabular-nums text-muted">{rollUp ?? "—"}</p>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
        {cards.length === 0 ? (
          <p className="grid flex-1 place-items-center px-2 py-6 text-center text-xs text-muted">
            No cards in this stage
          </p>
        ) : (
          cards.map((card) => (
            <PipelineCard
              key={card.card_id}
              card={card}
              template={template}
              locale={locale}
              currency={currency}
              movable={movePermitted}
              lifted={dragCardId === card.card_id}
              dimmed={dragCardId === card.card_id}
              onMove={() => onMove(card)}
              onPointerDown={(event) => onCardPointerDown(event, card)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function MoveToast({
  toast,
  busy,
  onUndo,
  onDismiss,
}: {
  toast: BoardToast | null;
  busy: boolean;
  onUndo: (undo: NonNullable<BoardToast["undo"]>) => void;
  onDismiss: () => void;
}) {
  // Portalled for the same reason as the move menu: fixed positioning has to resolve
  // against the viewport, not against the animated page section.
  return createPortal(
    <div
      aria-live="polite"
      className="pipeline-move-toast pointer-events-none fixed inset-x-4 z-[60] lg:left-[16.5rem] lg:right-4"
    >
      {toast ? (
        <div
          role={toast.tone === "error" ? "alert" : undefined}
          className={cn(
            "pointer-events-auto mx-auto flex max-w-lg items-center justify-between gap-3 rounded-lg border px-3 py-2 shadow-[0_16px_40px_oklch(0_0_0/0.24)]",
            toast.tone === "error"
              ? "border-danger/35 bg-danger-soft"
              : "border-border bg-surface-raised",
          )}
        >
          <p className="min-w-0 text-sm font-bold">{toast.message}</p>
          <div className="flex shrink-0 items-center gap-1">
            {toast.undo ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onUndo(toast.undo!)}
                className="flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-black text-accent transition-colors hover:bg-surface-muted disabled:opacity-55"
              >
                <Undo2 className="size-4" aria-hidden="true" />
                Undo
              </button>
            ) : null}
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss message"
              className="grid size-11 place-items-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * Column-scoped skeletons, not one page spinner: the board's shape is legible while the
 * cards stream in, and every column header already shows its own placeholder roll-up.
 */
function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading the board">
      {[0, 1, 2].map((column) => (
        <div
          key={column}
          className="flex w-full shrink-0 flex-col rounded-lg border border-border bg-surface sm:w-[85vw] lg:w-[16.5rem]"
        >
          <div className="flex min-h-16 flex-col justify-center gap-1 border-b border-border px-3 py-2">
            <div className="ui-skeleton h-3.5 w-24 rounded-sm bg-surface-muted" />
            <p className="text-sm font-bold text-muted">—</p>
          </div>
          <div className="space-y-2 p-2">
            {[0, 1].map((card) => (
              <div key={card} className="ui-skeleton h-24 rounded-lg bg-surface-muted" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function messageForError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 0) {
    return "No connection to IronWrap OS. The card stayed where it was.";
  }
  if (error instanceof ApiError && error.message) return `${error.message} ${fallback}`.trim();
  return fallback;
}
