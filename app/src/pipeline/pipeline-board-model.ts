import { ApiError } from "../lib/api";
import type { AppRole } from "../lib/roles";
import type {
  BoardCard,
  BoardStage,
  CardSummary,
  CardTemplateBinding,
  CardTransitionResponse,
  PipelineBoardResponse,
  PipelineSummary,
} from "./pipeline-contracts";

/**
 * Every rule the board applies to a move lives here, as plain functions over plain
 * data, so the same rule can be read by the drag path, the touch sheet and the
 * keyboard menu — and asserted in a test without rendering anything.
 *
 * The server is the authority on all of it (ELEC-155 section 4). This module exists so
 * the UI's fast guess matches the server's answer, not so the UI can decide instead.
 */

/** Long-press threshold before a card lifts on touch (UX spec section 3, check 5). */
export const LONG_PRESS_MS = 250;

/**
 * How long the Undo affordance stays on the toast (PO decision D1, UX spec section 3).
 * The server accepts an undo for 30s; the UI deliberately offers the shorter window so
 * the affordance never outlives the server's acceptance of it.
 */
export const UNDO_WINDOW_MS = 5_000;

/** Pointer travel that turns a press into a drag rather than a tap. */
export const DRAG_START_DISTANCE_PX = 6;

/** Fresh cards land after the last card in the target column. */
export const STAGE_POSITION_STEP = 10;

/**
 * The action name the board reads out of the read model's `allowed_actions`.
 * ELEC-155 specifies a `pipeline:card:move`-shaped permission; the app's envelope
 * spells actions with dots, and the elevated variant is accepted as well.
 */
export const CARD_MOVE_ACTIONS = ["pipeline.card.move", "pipeline.card.move.any"] as const;

export type MoveKind = "same" | "adjacent_forward" | "skip_ahead" | "backward";

export function classifyMove(fromPosition: number, toPosition: number): MoveKind {
  if (toPosition === fromPosition) return "same";
  if (toPosition < fromPosition) return "backward";
  return toPosition === fromPosition + 1 ? "adjacent_forward" : "skip_ahead";
}

export function canMoveCards(allowedActions: readonly string[]): boolean {
  return allowedActions.some((action) => (CARD_MOVE_ACTIONS as readonly string[]).includes(action));
}

/**
 * Whether this actor may enter a stage at all.
 *
 * The server answers this question itself on every stage of the board read (`can_enter`,
 * `buildPipelineBoardReadModel`), and its answer WINS: an administrator who restricts a
 * stage, or grants a role write on one pipeline only (0122 role grants), must land on the
 * board without a client release. The role comparison below is only the fallback for a
 * payload that carried no `can_enter`, and it stays a mirror of the rule, never its owner
 * — a stage the client thinks is open can still come back `403 stage_entry_role_required`,
 * and the optimistic move is rolled back when it does.
 */
export function canEnterStage(
  role: AppRole,
  stage: Pick<BoardStage, "min_role_to_enter" | "can_enter">,
): boolean {
  if (typeof stage.can_enter === "boolean") return stage.can_enter;
  if (!stage.min_role_to_enter) return true;
  if (role === "owner" || role === "ops") return true;
  return role === stage.min_role_to_enter;
}

/**
 * Which board a role app opens on when the account holds several.
 *
 * The list route is already role-scoped and deny-by-default (`canViewPipeline`), so this
 * does NOT filter: hiding a board the administrator deliberately granted to this role
 * would make a configured grant unreachable, and client-side hiding was never the
 * authority anyway. It only decides the default selection — a role app opens on the board
 * this role owns, and reaches the rest through the switcher.
 */
export function preferredPipeline(
  pipelines: readonly PipelineSummary[],
  role: AppRole,
  selectedPipelineId: string | null,
): PipelineSummary | undefined {
  const selected = pipelines.find((pipeline) => pipeline.pipeline_id === selectedPipelineId);
  if (selected) return selected;
  return pipelines.find((pipeline) => pipeline.owning_role === role) ?? pipelines[0];
}

/**
 * PO decision D2 — one safeguard rule, and won/lost does not add a second.
 *
 * A move forward by exactly one stage is always direct, INCLUDING into a stage flagged
 * `is_won` or `is_lost`: on the stakeholder's seeded board that is the ordinary move a
 * salesperson makes all day, and undo is the accident protection there, not a dialog.
 * Backward, skip-ahead and role-restricted moves take one explicit confirm.
 */
export function moveNeedsConfirmation(
  kind: MoveKind,
  stage: Pick<BoardStage, "min_role_to_enter">,
): boolean {
  if (kind === "same") return false;
  if (stage.min_role_to_enter) return true;
  return kind !== "adjacent_forward";
}

export function moveConfirmationPrompt(
  kind: MoveKind,
  fromStage: BoardStage | undefined,
  toStage: BoardStage,
): string {
  if (toStage.min_role_to_enter && kind === "adjacent_forward") {
    return `Move to ${toStage.name}? Only ${toStage.min_role_to_enter} normally works in this stage.`;
  }
  if (kind === "backward") {
    return `Move backward to ${toStage.name}? This reverses the progress recorded${
      fromStage ? ` in ${fromStage.name}` : ""
    }.`;
  }
  if (kind === "skip_ahead") {
    return `Move to ${toStage.name}? This skips ${skippedStageCount(fromStage, toStage)}.`;
  }
  return `Move to ${toStage.name}?`;
}

function skippedStageCount(fromStage: BoardStage | undefined, toStage: BoardStage): string {
  if (!fromStage) return "a stage";
  const skipped = toStage.position - fromStage.position - 1;
  return skipped === 1 ? "one stage" : `${skipped} stages`;
}

// ---------------------------------------------------------------------------
// What the server refused, and what the person holding the phone should do next
// ---------------------------------------------------------------------------

/**
 * The card version a committed transition leaves behind.
 *
 * The route answers with a flat `card_version` (`transitionPayload`); the nested `card`
 * shape is read too so an older server still yields a usable token. This is the value the
 * undo route requires back as `expected_version` — reading it wrong is not a cosmetic
 * miss, it is an undo that always 400s.
 */
export function cardVersionAfterTransition(
  response: Pick<CardTransitionResponse, "card_version" | "card">,
): number | undefined {
  if (typeof response.card_version === "number") return response.card_version;
  const nested = response.card?.version;
  return typeof nested === "number" ? nested : undefined;
}

/**
 * How long to leave Undo on screen. The client's own window (5s) is deliberately shorter
 * than the server's, and when the server names its window on the response we clamp to
 * whichever is shorter so the button can never outlive the acceptance behind it.
 */
export function undoWindowMs(serverWindowSeconds?: number): number {
  if (typeof serverWindowSeconds !== "number" || !Number.isFinite(serverWindowSeconds)) {
    return UNDO_WINDOW_MS;
  }
  return Math.max(0, Math.min(UNDO_WINDOW_MS, Math.round(serverWindowSeconds * 1_000)));
}

export interface MoveBlocker {
  /** The server's own blocker code, kept so the surface can branch and a test can assert it. */
  code: string;
  /** What the person sees. Always says where the card ended up. */
  message: string;
  /** `confirm` means the server wants the explicit confirmation step, not an error toast. */
  outcome: "confirm" | "refused";
  /** True when re-reading the board is what makes the next attempt work. */
  refresh: boolean;
}

/**
 * Every refusal the transition route can answer with, rendered as the exact blocker rather
 * than one generic "something went wrong".
 *
 * The codes are transcribed from `workers-bus/src/pipeline-board-api.ts`; the details the
 * server attaches to them (`required_role`, `card_version`) are read back out of the error
 * body so the message names the actual reason, not a category of reason.
 */
export function describeMoveBlocker(
  error: unknown,
  context: { toStageName?: string },
): MoveBlocker {
  const stage = context.toStageName ?? "that stage";
  if (!(error instanceof ApiError)) {
    return {
      code: "unknown_error",
      message: "The move did not go through. The card stayed where it was.",
      outcome: "refused",
      refresh: false,
    };
  }
  if (error.code === "confirmation_required") {
    return { code: error.code, message: "", outcome: "confirm", refresh: false };
  }
  switch (error.code) {
    case "pipeline_card_version_conflict": {
      const version = error.detailNumber("card_version");
      return {
        code: error.code,
        message: `Someone else changed this card first${
          version === undefined ? "." : `. It is now at version ${version}.`
        } The board has been refreshed; check the card and move it again.`,
        outcome: "refused",
        refresh: true,
      };
    }
    case "stage_entry_role_required": {
      const required = error.detailText("required_role");
      return {
        code: error.code,
        message: `Your role cannot move a card into ${stage}${
          required === undefined ? "." : `. It is reserved for ${required}.`
        } The card stayed where it was.`,
        outcome: "refused",
        refresh: false,
      };
    }
    case "pipeline_move_forbidden":
      return {
        code: error.code,
        message:
          "You can read this board but not move its cards. Ask the office for the move permission on this pipeline.",
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_transition_noop":
      return {
        code: error.code,
        message: `The card is already in ${stage}. Nothing was changed.`,
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_entity_type_mismatch":
      return {
        code: error.code,
        message: "This card does not belong on this board. The card stayed where it was.",
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_entity_not_found":
    case "not_found":
      return {
        code: error.code,
        message: "This card or stage no longer exists on the board. The board has been refreshed.",
        outcome: "refused",
        refresh: true,
      };
    case "invalid_pipeline_transition":
    case "invalid_pipeline_card":
      return {
        code: error.code,
        message:
          "The board sent a move this server would not accept. Refresh the board and try again.",
        outcome: "refused",
        refresh: true,
      };
    case "csrf_failed":
      return {
        code: error.code,
        message: "Your session expired. Sign in again. The card stayed where it was.",
        outcome: "refused",
        refresh: false,
      };
    default:
      return {
        code: error.code,
        message: fallbackMoveMessage(error, "The card stayed where it was."),
        outcome: "refused",
        refresh: error.status === 409,
      };
  }
}

/**
 * The undo route's own refusals. It has more of them than the move does — the window, the
 * origin stage and the actor are all re-checked at undo time — and every one of them is a
 * different next step for the person, so none of them may collapse into "could not undo".
 */
export function describeUndoBlocker(
  error: unknown,
  context: { fromStageName?: string },
): MoveBlocker {
  const stage = context.fromStageName ?? "its previous stage";
  if (!(error instanceof ApiError)) {
    return {
      code: "unknown_error",
      message: "The move could not be undone. The card is still where the move put it.",
      outcome: "refused",
      refresh: false,
    };
  }
  switch (error.code) {
    case "pipeline_undo_window_expired": {
      const seconds = error.detailNumber("undo_window_seconds");
      return {
        code: error.code,
        message: `The undo window${
          seconds === undefined ? "" : ` of ${seconds} seconds`
        } has closed. Move the card back to ${stage} instead.`,
        outcome: "refused",
        refresh: true,
      };
    }
    case "pipeline_undo_superseded":
    case "pipeline_stage_changed":
      return {
        code: error.code,
        message: `This card has moved again since then, so the undo no longer applies. Move it back to ${stage} instead.`,
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_undo_actor_forbidden":
      return {
        code: error.code,
        message:
          "Only the person who made this move, or the account owner, can undo it. The card stayed where it is.",
        outcome: "refused",
        refresh: false,
      };
    case "pipeline_undo_not_undoable":
      return {
        code: error.code,
        message: "An undo cannot itself be undone. Move the card if it is in the wrong stage.",
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_undo_origin_unknown":
      return {
        code: error.code,
        message: `This card had no earlier stage to return to. Move it to ${stage} if that is where it belongs.`,
        outcome: "refused",
        refresh: true,
      };
    case "pipeline_card_version_conflict": {
      const version = error.detailNumber("card_version");
      return {
        code: error.code,
        message: `Someone else changed this card first${
          version === undefined ? "." : `. It is now at version ${version}.`
        } The undo was refused. The board has been refreshed.`,
        outcome: "refused",
        refresh: true,
      };
    }
    default:
      return {
        code: error.code,
        message: fallbackMoveMessage(error, "The move could not be undone."),
        outcome: "refused",
        refresh: error.status === 409,
      };
  }
}

function fallbackMoveMessage(error: ApiError, fallback: string): string {
  if (error.status === 0) return "No connection to IronWrap OS. The card stayed where it was.";
  return error.message ? `${error.message} ${fallback}`.trim() : fallback;
}

export function stageById(stages: readonly BoardStage[], stageId: string): BoardStage | undefined {
  return stages.find((stage) => stage.stage_id === stageId);
}

export function orderedStages(stages: readonly BoardStage[]): BoardStage[] {
  return [...stages].sort((left, right) => left.position - right.position);
}

export function cardsInStage(cards: readonly BoardCard[], stageId: string): BoardCard[] {
  return cards
    .filter((card) => card.stage_id === stageId)
    .sort((left, right) => (left.position_in_stage ?? 0) - (right.position_in_stage ?? 0));
}

/**
 * The optimistic half of a move: the card lands in the target column and both columns'
 * pre-aggregated header numbers move with it. Applied as a delta rather than a
 * recount, because the read model's `card_count` is the stage's true size and this
 * payload need not carry every one of its cards.
 */
export function applyOptimisticMove(
  board: PipelineBoardResponse,
  cardId: string,
  toStageId: string,
): PipelineBoardResponse {
  const card = board.cards.find((candidate) => candidate.card_id === cardId);
  if (!card || card.stage_id === toStageId) return board;
  const fromStageId = card.stage_id;
  const amount = typeof card.summary.amount_cents === "number" ? card.summary.amount_cents : 0;
  const lastPosition = cardsInStage(board.cards, toStageId).at(-1)?.position_in_stage ?? 0;

  return {
    ...board,
    stages: board.stages.map((stage) => {
      if (stage.stage_id === fromStageId) return shiftStageTotals(stage, -1, -amount);
      if (stage.stage_id === toStageId) return shiftStageTotals(stage, 1, amount);
      return stage;
    }),
    cards: board.cards.map((candidate) =>
      candidate.card_id === cardId
        ? {
            ...candidate,
            stage_id: toStageId,
            position_in_stage: lastPosition + STAGE_POSITION_STEP,
          }
        : candidate,
    ),
  };
}

function shiftStageTotals(stage: BoardStage, countDelta: number, amountDelta: number): BoardStage {
  return {
    ...stage,
    card_count: Math.max(0, (stage.card_count ?? 0) + countDelta),
    total_amount_cents:
      typeof stage.total_amount_cents === "number"
        ? stage.total_amount_cents + amountDelta
        : stage.total_amount_cents,
  };
}

// ---------------------------------------------------------------------------
// Card template binding
// ---------------------------------------------------------------------------

/**
 * The fallback layout, used when a pipeline ships no `card_template_json`. It binds
 * slots to summary fields by name — it does not hardcode them in the renderer, which
 * is what lets a Production board later declare a different identifier pair and no
 * services chip without a component change.
 */
export const DEFAULT_CARD_TEMPLATE: CardTemplateBinding[] = [
  { slot: "title", source_field: "title" },
  { slot: "badge", source_field: "is_won", label: "WON" },
  { slot: "value", source_field: "amount_cents", format: "currency_cents" },
  { slot: "identifiers", source_field: "identifiers", limit: 2 },
  { slot: "tags", source_field: "tags", limit: 2 },
  { slot: "counters", source_field: "counters", limit: 4 },
];

export type CardSlot =
  | { slot: "title"; text: string }
  | { slot: "badge"; text: string }
  | { slot: "value"; text: string }
  | { slot: "identifiers"; items: Array<{ label: string; value: string }> }
  | { slot: "tags"; items: string[]; overflow: number }
  | { slot: "counters"; items: Array<{ kind: string; count: number }> };

export interface CardSlotOptions {
  locale: string;
  currency: string;
}

/**
 * Render-ready slots for one card. A binding whose source field is absent, null or
 * empty produces NO slot at all — PO decision D4: a fabricated `$0.00` on an
 * early-stage card is worse than a blank one, and the same holds for an identifier
 * line the import never supplied (D6).
 */
export function cardSlots(
  template: readonly CardTemplateBinding[] | null | undefined,
  summary: CardSummary,
  options: CardSlotOptions,
): CardSlot[] {
  const bindings = template && template.length > 0 ? template : DEFAULT_CARD_TEMPLATE;
  const slots: CardSlot[] = [];
  for (const binding of bindings) {
    const slot = renderSlot(binding, summary, options);
    if (slot) slots.push(slot);
  }
  return slots;
}

function renderSlot(
  binding: CardTemplateBinding,
  summary: CardSummary,
  options: CardSlotOptions,
): CardSlot | null {
  const value = summary[binding.source_field];
  switch (binding.slot) {
    case "title": {
      return typeof value === "string" && value.trim() ? { slot: "title", text: value } : null;
    }
    case "badge": {
      return value === true ? { slot: "badge", text: binding.label ?? "WON" } : null;
    }
    case "value": {
      const text = formatSlotValue(value, binding.format, options);
      return text ? { slot: "value", text } : null;
    }
    case "identifiers": {
      const items = identifierItems(value).slice(0, binding.limit ?? 2);
      return items.length > 0 ? { slot: "identifiers", items } : null;
    }
    case "tags": {
      const all = Array.isArray(value) ? value.filter(isNonEmptyString) : [];
      const limit = binding.limit ?? 2;
      return all.length > 0
        ? { slot: "tags", items: all.slice(0, limit), overflow: Math.max(0, all.length - limit) }
        : null;
    }
    case "counters": {
      const items = counterItems(value).slice(0, binding.limit ?? 4);
      return items.length > 0 ? { slot: "counters", items } : null;
    }
    default:
      // A slot this build does not know yet is skipped, not fatal.
      return null;
  }
}

function formatSlotValue(
  value: unknown,
  format: string | null | undefined,
  options: CardSlotOptions,
): string | null {
  if (format === "currency_cents") {
    return typeof value === "number" && Number.isFinite(value)
      ? formatMoneyFromCents(value, options.locale, options.currency)
      : null;
  }
  if (typeof value === "number" && Number.isFinite(value))
    return value.toLocaleString(options.locale);
  return isNonEmptyString(value) ? value : null;
}

function identifierItems(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return isNonEmptyString(record.label) && isNonEmptyString(record.value)
      ? [{ label: record.label, value: record.value }]
      : [];
  });
}

function counterItems(value: unknown): Array<{ kind: string; count: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return isNonEmptyString(record.kind) && typeof record.count === "number" && record.count > 0
      ? [{ kind: record.kind, count: record.count }]
      : [];
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function formatMoneyFromCents(cents: number, locale: string, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(locale)}`;
  }
}

export function stageRollUp(stage: BoardStage, locale: string, currency: string): string | null {
  return typeof stage.total_amount_cents === "number"
    ? formatMoneyFromCents(stage.total_amount_cents, locale, currency)
    : null;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/* ------------------------------------------------------- putting work on a board ------ */

/**
 * Something the product can put on a board: a generic (type, id) pair plus what to call it.
 *
 * The type is the core vocabulary the server's entity registry publishes (`lead`, `job` today),
 * never a vertical noun, so the surface that offers this does not learn a roofing word to do it.
 */
export interface PlaceableEntity {
  entityType: string;
  entityId: string;
  /** What the person calls this thing — "Pat Prospect", "Job IW-1001". */
  label: string;
  /** The kind, in the person's words. Server-supplied where one is available. */
  typeLabel: string;
}

export interface BoardPlacementOption {
  pipeline: PipelineSummary;
  entity: PlaceableEntity;
}

/**
 * Which boards this session may actually put one of these entities on, in the server's order.
 *
 * Both halves of the answer come from `GET /api/v1/pipelines` and neither is reconstructed here:
 * `entity_type` is the binding the administrator chose for the board, and `can_move` is the
 * server's own fold of `owning_role` plus the per-pipeline role grants. A board is offered only
 * when the server said BOTH — an unknown value is treated as "not offered" rather than guessed,
 * because offering a board the server will refuse is how a user learns to ignore refusals.
 *
 * This is a mirror, not the authority. `handleCardPlacement` re-checks the same two rules and a
 * refusal from it is rendered as itself; hiding a board here never stands in for that check.
 */
export function boardPlacementOptions(
  pipelines: readonly PipelineSummary[],
  entities: readonly PlaceableEntity[],
): BoardPlacementOption[] {
  const options: BoardPlacementOption[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.can_move !== true) continue;
    const entity = entities.find((candidate) => candidate.entityType === pipeline.entity_type);
    if (entity) options.push({ pipeline, entity });
  }
  return options;
}

/**
 * The pipeline list's cache key, shared by the board screen and by every surface that offers
 * "add to board": one fetch answers both, and neither can drift onto its own key.
 */
export function pipelineListQueryKey(tenantId: string, userId: string): [string, string, string] {
  return ["pipelines", tenantId, userId];
}

/** Where this role reads its boards, matching the per-role mounts in `router.tsx`. */
export function pipelineBoardRoute(role: AppRole): "/sales/board" | "/owner/board" {
  return role === "sales" ? "/sales/board" : "/owner/board";
}

export interface PlacementBlocker {
  /** The server's own code, so a test asserts the mapping rather than the prose. */
  code: string;
  message: string;
  /**
   * True when the entity is on the board already and the refusal is not a failure — the card is
   * there, so the surface reports the outcome rather than an error.
   */
  alreadyPlaced: boolean;
}

/**
 * Every refusal `POST /api/v1/pipelines/{id}/cards` can answer with, rendered as itself.
 *
 * The codes are transcribed from `handleCardPlacement` and `placeCard`
 * (`workers-bus/src/pipeline-board-api.ts`, `workers-bus/src/pipeline-board-store.ts`). Each one
 * needs a different next step from the person, so none of them collapses into "could not add".
 */
export function describePlacementBlocker(
  error: unknown,
  context: { boardName?: string; entityLabel?: string },
): PlacementBlocker {
  const board = context.boardName ?? "that board";
  const entity = context.entityLabel ?? "This";
  if (!(error instanceof ApiError)) {
    return {
      code: "unknown_error",
      message: `${entity} was not added to ${board}. Nothing was changed.`,
      alreadyPlaced: false,
    };
  }
  switch (error.code) {
    case "pipeline_move_forbidden":
      return {
        code: error.code,
        message: `You can read ${board} but not add cards to it. Ask the office for the move permission on this pipeline.`,
        alreadyPlaced: false,
      };
    case "pipeline_entity_type_mismatch":
    case "pipeline_entity_type_unknown":
      return {
        code: error.code,
        message: `${board} tracks a different kind of work, so ${entity} cannot go on it. Nothing was changed.`,
        alreadyPlaced: false,
      };
    case "pipeline_entity_not_found":
      return {
        code: error.code,
        message: `${entity} is not in the office system yet, so it cannot go on a board. Refresh and try again.`,
        alreadyPlaced: false,
      };
    // The card already exists for this (board, entity) pair but was first placed by someone else
    // or into another stage, so the replay fingerprint does not match. The card IS on the board;
    // saying "it failed" would send the person looking for a problem that is not there.
    case "pipeline_transition_idempotency_conflict":
      return {
        code: error.code,
        message: `${entity} is already on ${board}. Nothing was changed.`,
        alreadyPlaced: true,
      };
    case "not_found":
      return {
        code: error.code,
        message: `${board} is no longer available to you. Refresh and try again.`,
        alreadyPlaced: false,
      };
    case "invalid_pipeline_card":
    case "idempotency_key_required":
      return {
        code: error.code,
        message: `The app sent something this server would not accept. Refresh and try again. ${entity} was not added.`,
        alreadyPlaced: false,
      };
    case "csrf_failed":
      return {
        code: error.code,
        message: `Your session expired. Sign in again. ${entity} was not added.`,
        alreadyPlaced: false,
      };
    default:
      return {
        code: error.code,
        message:
          error.status === 0
            ? `No connection to IronWrap OS. ${entity} was not added to ${board}.`
            : error.message
              ? `${error.message} ${entity} was not added to ${board}.`
              : `${entity} was not added to ${board}.`,
        alreadyPlaced: false,
      };
  }
}
