import type { AppRole } from "../lib/roles";
import type {
  BoardCard,
  BoardStage,
  CardSummary,
  CardTemplateBinding,
  PipelineBoardResponse,
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
 * Whether this actor may enter a stage at all. `min_role_to_enter` is unset on every
 * M1-seeded stage, so this only bites once an administrator restricts one in M3.
 *
 * The client mirrors the rule; it does not own it. A stage the client thinks is open
 * can still come back `403 stage_entry_role_required`, and the optimistic move is
 * rolled back when it does.
 */
export function canEnterStage(
  role: AppRole,
  stage: Pick<BoardStage, "min_role_to_enter">,
): boolean {
  if (!stage.min_role_to_enter) return true;
  if (role === "owner" || role === "ops") return true;
  return role === stage.min_role_to_enter;
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
