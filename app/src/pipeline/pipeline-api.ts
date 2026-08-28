import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  cardPlacementResponseSchema,
  cardTransitionResponseSchema,
  pipelineBoardResponseSchema,
  pipelineListResponseSchema,
  type CardPlacementResponse,
  type CardTransitionResponse,
  type PipelineBoardResponse,
  type PipelineListResponse,
} from "./pipeline-contracts";

export async function loadPipelines(fetcher: typeof fetch = fetch): Promise<PipelineListResponse> {
  return await apiRequest({
    path: API_PATHS.pipelines,
    schema: pipelineListResponseSchema,
    fetcher,
  });
}

export async function loadPipelineBoard(
  pipelineId: string,
  fetcher: typeof fetch = fetch,
): Promise<PipelineBoardResponse> {
  return await apiRequest({
    path: API_PATHS.pipelineBoard(pipelineId),
    schema: pipelineBoardResponseSchema,
    fetcher,
  });
}

/**
 * One key per (card, target stage) attempt, held by the caller across a
 * `confirmation_required` round trip: ELEC-155 section 4 has the client re-submit the
 * *identical* idempotency key with `confirmed: true`, so the confirm is the same
 * command rather than a second one.
 */
export function newCardMoveKey(): string {
  return `pipeline-card-move:${crypto.randomUUID()}`;
}

export function newCardMoveUndoKey(): string {
  return `pipeline-card-move-undo:${crypto.randomUUID()}`;
}

export interface CardMoveInput {
  pipelineId: string;
  cardId: string;
  toStageId: string;
  /**
   * The card's CAS token. Sent only when the read model supplied one — a board that
   * renders without card versions still shows the work; the server stays the authority
   * on whether it will accept a move without one.
   */
  expectedVersion?: number;
  confirmed?: boolean;
}

export async function moveCardToStage(
  session: AuthenticatedSession,
  input: CardMoveInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CardTransitionResponse> {
  return await apiRequest({
    path: API_PATHS.pipelineCardTransitions(input.pipelineId, input.cardId),
    schema: cardTransitionResponseSchema,
    method: "POST",
    body: {
      to_stage_id: input.toStageId,
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
      ...(input.confirmed ? { confirmed: true } : {}),
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export interface CardMoveUndoInput {
  pipelineId: string;
  cardId: string;
  transitionId: string;
  /**
   * The card's version AFTER the move being undone. REQUIRED: the undo route parses it
   * before anything else and answers `400 invalid_pipeline_transition` when it is absent
   * (`handleUndo`, `workers-bus/src/pipeline-board-api.ts`), so an undo posted without it
   * can never succeed. It comes from the move response's `card_version`, or from the
   * refreshed board when that arrived first.
   */
  expectedVersion: number;
}

export async function undoCardMove(
  session: AuthenticatedSession,
  input: CardMoveUndoInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CardTransitionResponse> {
  return await apiRequest({
    path: API_PATHS.pipelineCardTransitionUndo(input.pipelineId, input.cardId, input.transitionId),
    schema: cardTransitionResponseSchema,
    method: "POST",
    body: { expected_version: input.expectedVersion },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

/**
 * One key per placement attempt. The route demands an `idempotency-key` header matching
 * `^[A-Za-z0-9._:-]{8,140}$` and answers `400 idempotency_key_required` without one
 * (`handleCardPlacement`, `workers-bus/src/pipeline-board-api.ts`).
 */
export function newCardPlacementKey(): string {
  return `pipeline-card-place:${crypto.randomUUID()}`;
}

export interface CardPlacementInput {
  pipelineId: string;
  entityType: string;
  entityId: string;
  /**
   * Which column the card lands in. Omitted by this surface on purpose: the server puts a
   * new card in the board's FIRST stage, which is what "add this lead to the board" means.
   * Kept on the input so a future surface that places into a named stage does not have to
   * fork the call.
   */
  stageKey?: string;
}

/**
 * Put an entity on a board.
 *
 * Every rule that matters is the server's: it re-checks that the session may write this
 * pipeline, that `entity_type` matches what the board binds, and that the entity exists in
 * THIS tenant. The client's filtering is a mirror so the person is not offered a board that
 * will refuse them — it is not the authority, and a refusal is rendered as itself.
 */
export async function placeCardOnPipeline(
  session: AuthenticatedSession,
  input: CardPlacementInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CardPlacementResponse> {
  return await apiRequest({
    path: API_PATHS.pipelineCards(input.pipelineId),
    schema: cardPlacementResponseSchema,
    method: "POST",
    body: {
      entity_type: input.entityType,
      entity_id: input.entityId,
      ...(input.stageKey ? { stage_key: input.stageKey } : {}),
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}
