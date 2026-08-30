import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CloudOff, KanbanSquare, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { useOnlineStatus } from "../hooks/use-online-status";
import { loadPipelines, newCardPlacementKey, placeCardOnPipeline } from "./pipeline-api";
import {
  boardPlacementOptions,
  describePlacementBlocker,
  pipelineBoardRoute,
  pipelineListQueryKey,
  type BoardPlacementOption,
  type PlaceableEntity,
} from "./pipeline-board-model";

/**
 * The one product-UI path that puts an entity on a pipeline board.
 *
 * WHY on the entity and not on the board. A board can only offer "add a card" by first listing
 * every entity of its type that is not on it yet, and no route publishes that list — building one
 * from the client would mean growing the API sideways. The decision to track something also forms
 * while the person is looking at the thing, not at the board. Automatic placement on creation was
 * the third option and is deliberately not taken: it would need the per-pipeline opt-out an
 * administrator owns, which is server configuration and schema this lane does not own.
 *
 * The dialog knows nothing about leads or jobs. It takes generic `(entity_type, entity_id)` pairs
 * and asks the SERVER which boards accept them, so a module that registers a new entity type is
 * placeable through this same surface without a change to this file.
 */
export function AddToBoardDialog({
  entities,
  onClose,
  onPlaced,
}: {
  entities: readonly PlaceableEntity[];
  onClose: () => void;
  onPlaced?: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  // A placement is committed on the server or not at all — it is never queued on this device.
  // Say so rather than let the screen offer a write it would silently drop.
  const live = online && !isOfflineSession(session);
  const listRef = useRef<HTMLDivElement>(null);

  /** The outcome once the card exists on a board — freshly placed, or already there. */
  const [placed, setPlaced] = useState<{ message: string } | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);

  const pipelines = useQuery({
    queryKey: pipelineListQueryKey(session.tenant.id, session.user.id),
    queryFn: () => loadPipelines(),
    enabled: live,
  });

  const options = boardPlacementOptions(pipelines.data?.pipelines ?? [], entities);

  const place = useMutation({
    retry: false,
    mutationFn: async (option: BoardPlacementOption) =>
      await placeCardOnPipeline(
        session,
        {
          pipelineId: option.pipeline.pipeline_id,
          entityType: option.entity.entityType,
          entityId: option.entity.entityId,
        },
        newCardPlacementKey(),
      ),
    onMutate: () => setBlocker(null),
    onSuccess: (_response, option) =>
      reportPlaced(`${option.entity.label} is on ${option.pipeline.name}, in its first stage.`),
    onError: (error, option) => {
      const refusal = describePlacementBlocker(error, {
        boardName: option.pipeline.name,
        entityLabel: option.entity.label,
      });
      // "It is already there" is an outcome, not a failure: the card the person wanted exists.
      // Its stage is NOT claimed here — the first placement decided that, not this attempt.
      if (refusal.alreadyPlaced) {
        reportPlaced(refusal.message);
        return;
      }
      setBlocker(refusal.message);
    },
  });

  function reportPlaced(message: string) {
    setPlaced({ message });
    // Every cached board read and every card count is now stale.
    void queryClient.invalidateQueries({ queryKey: ["pipeline-board", session.tenant.id] });
    void queryClient.invalidateQueries({
      queryKey: pipelineListQueryKey(session.tenant.id, session.user.id),
    });
    onPlaced?.();
  }

  useEffect(() => {
    if (placed) {
      listRef.current?.querySelector<HTMLElement>("[data-open-board]")?.focus();
      return;
    }
    listRef.current?.querySelector<HTMLButtonElement>("button[data-pipeline-id]")?.focus();
  }, [placed, options.length]);

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-pipeline-id]:not(:disabled)",
      ) ?? []),
    ];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1 + rows.length) % rows.length
        : (index - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  }

  // Portalled for the same reason as the move menu: `.app-main > *` animates a transform, and an
  // ancestor with an animated transform becomes the containing block for `position: fixed`.
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
        aria-label="Add to a board"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        className="max-h-[min(85dvh,42rem)] w-full overflow-y-auto overscroll-contain rounded-t-xl border border-border bg-surface p-3 shadow-[0_-12px_48px_oklch(0_0_0/0.28)] sm:max-w-md sm:rounded-xl sm:shadow-[0_24px_72px_oklch(0_0_0/0.28)]"
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-1 pb-2">
          <p className="min-w-0 truncate text-sm font-extrabold">
            {placed ? "On the board" : "Add to a board"}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add to board"
            className="grid size-11 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        <div ref={listRef} className="mt-2 space-y-2" onKeyDown={onListKeyDown}>
          {placed ? (
            <>
              <p role="status" className="px-1 text-sm font-semibold leading-6">
                {placed.message}
              </p>
              <Button asChild variant="accent" fullWidth>
                <Link data-open-board to={pipelineBoardRoute(session.user.role)}>
                  <KanbanSquare aria-hidden="true" />
                  Open the board
                </Link>
              </Button>
              <Button variant="outline" fullWidth onClick={onClose}>
                Stay here
              </Button>
            </>
          ) : (
            <>
              {!live ? (
                <Notice tone="warning" title="Offline: a card cannot be added">
                  A card is saved on the server, not on this device, so nothing here is queued.
                  Reconnect and add it then.
                </Notice>
              ) : null}
              {blocker ? (
                <Notice tone="danger" title="Not added">
                  {blocker}
                </Notice>
              ) : null}
              {live && pipelines.isPending ? (
                <p className="px-1 py-4 text-sm text-muted">Loading your boards…</p>
              ) : null}
              {live && pipelines.isError ? (
                <Notice tone="danger" title="Your boards did not load">
                  Nothing was changed. Close this and try again.
                </Notice>
              ) : null}
              {live && !pipelines.isPending && !pipelines.isError && options.length === 0 ? (
                <Notice tone="info" title="No board takes this yet">
                  You have no board that tracks this kind of work and that you may add to. An
                  administrator sets one up in Settings → Pipelines.
                </Notice>
              ) : null}
              {options.map((option) => (
                <button
                  key={option.pipeline.pipeline_id}
                  type="button"
                  data-pipeline-id={option.pipeline.pipeline_id}
                  disabled={!live || place.isPending}
                  aria-busy={
                    place.isPending &&
                    place.variables?.pipeline.pipeline_id === option.pipeline.pipeline_id
                      ? true
                      : undefined
                  }
                  onClick={() => place.mutate(option)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg bg-surface-raised px-3 text-left text-sm font-bold text-foreground transition-colors hover:bg-surface-muted disabled:opacity-55"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{option.pipeline.name}</span>
                    <span className="block truncate text-xs font-semibold text-muted">
                      Adds {option.entity.typeLabel} {option.entity.label}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted">
                    {live ? (
                      <Plus className="size-4" aria-hidden="true" />
                    ) : (
                      <CloudOff className="size-4" aria-label="Offline" />
                    )}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
