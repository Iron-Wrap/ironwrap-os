import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  cardTransitionResponseSchema,
  pipelineBoardResponseSchema,
  pipelineListResponseSchema,
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

export async function undoCardMove(
  session: AuthenticatedSession,
  input: { pipelineId: string; cardId: string; transitionId: string },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CardTransitionResponse> {
  return await apiRequest({
    path: API_PATHS.pipelineCardTransitionUndo(input.pipelineId, input.cardId, input.transitionId),
    schema: cardTransitionResponseSchema,
    method: "POST",
    body: {},
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}
