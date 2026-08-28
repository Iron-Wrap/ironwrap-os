import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  applyOptimisticMove,
  canEnterStage,
  canMoveCards,
  cardSlots,
  cardsInStage,
  cardVersionAfterTransition,
  classifyMove,
  DEFAULT_CARD_TEMPLATE,
  describeMoveBlocker,
  describeUndoBlocker,
  formatMoneyFromCents,
  LONG_PRESS_MS,
  moveConfirmationPrompt,
  moveNeedsConfirmation,
  orderedStages,
  preferredPipeline,
  stageRollUp,
  undoWindowMs,
  UNDO_WINDOW_MS,
} from "./pipeline-board-model";
import type {
  BoardStage,
  CardSummary,
  PipelineBoardResponse,
  PipelineSummary,
} from "./pipeline-contracts";

function stage(
  overrides: Partial<BoardStage> & Pick<BoardStage, "stage_id" | "position">,
): BoardStage {
  return {
    key: overrides.stage_id,
    name: overrides.stage_id,
    is_won: false,
    is_lost: false,
    card_count: 0,
    total_amount_cents: 0,
    min_role_to_enter: null,
    ...overrides,
  };
}

const seededStages = [
  stage({ stage_id: "new_lead", name: "New Lead", position: 0 }),
  stage({ stage_id: "visit_booked", name: "Visit Booked", position: 1 }),
  stage({ stage_id: "need_quote", name: "Need Quote", position: 2 }),
  stage({ stage_id: "quote_sent", name: "Quote Sent", position: 3 }),
  stage({ stage_id: "contract_signed", name: "Contract signed", position: 4, is_won: true }),
];

describe("pipeline board move rules", () => {
  it("pins the two timing constants the UX spec names", () => {
    expect(LONG_PRESS_MS).toBe(250);
    expect(UNDO_WINDOW_MS).toBe(5_000);
  });

  it("classifies a move by stage position, not by stage name", () => {
    expect(classifyMove(2, 3)).toBe("adjacent_forward");
    expect(classifyMove(2, 4)).toBe("skip_ahead");
    expect(classifyMove(3, 1)).toBe("backward");
    expect(classifyMove(3, 3)).toBe("same");
  });

  // PO decision D2 — the whole point of the narrowing: an adjacent-forward move is
  // direct even when it lands on the WON stage, because that is the move the
  // stakeholder's salespeople make all day.
  it("keeps an adjacent-forward move direct, including into a won stage", () => {
    const contractSigned = seededStages[4]!;
    expect(contractSigned.is_won).toBe(true);
    expect(moveNeedsConfirmation("adjacent_forward", contractSigned)).toBe(false);
  });

  it("confirms backward, skip-ahead and role-restricted moves only", () => {
    const open = seededStages[2]!;
    const restricted = stage({
      stage_id: "deposit",
      name: "Deposit",
      position: 5,
      min_role_to_enter: "accounting",
    });
    expect(moveNeedsConfirmation("backward", open)).toBe(true);
    expect(moveNeedsConfirmation("skip_ahead", open)).toBe(true);
    expect(moveNeedsConfirmation("adjacent_forward", restricted)).toBe(true);
    expect(moveNeedsConfirmation("same", open)).toBe(false);
  });

  it("locks a restricted stage for the role that may not enter it", () => {
    const restricted = stage({
      stage_id: "deposit",
      position: 5,
      min_role_to_enter: "accounting",
    });
    expect(canEnterStage("sales", restricted)).toBe(false);
    expect(canEnterStage("accounting", restricted)).toBe(true);
    expect(canEnterStage("owner", restricted)).toBe(true);
    expect(canEnterStage("sales", seededStages[0]!)).toBe(true);
  });

  it("reads the move right off the read model's allowed actions", () => {
    expect(canMoveCards(["pipeline.read"])).toBe(false);
    expect(canMoveCards(["pipeline.read", "pipeline.card.move"])).toBe(true);
    expect(canMoveCards(["pipeline.card.move.any"])).toBe(true);
  });

  it("names what a confirm is actually confirming", () => {
    expect(moveConfirmationPrompt("backward", seededStages[3], seededStages[0]!)).toContain(
      "Move backward to New Lead?",
    );
    expect(moveConfirmationPrompt("skip_ahead", seededStages[1], seededStages[4]!)).toContain(
      "skips 2 stages",
    );
    expect(moveConfirmationPrompt("skip_ahead", seededStages[2], seededStages[4]!)).toContain(
      "skips one stage",
    );
  });

  it("orders stages by position and cards by their in-stage position", () => {
    expect(
      orderedStages([seededStages[3]!, seededStages[0]!]).map((item) => item.stage_id),
    ).toEqual(["new_lead", "quote_sent"]);
    expect(
      cardsInStage(
        [
          { card_id: "b", stage_id: "s", position_in_stage: 20, summary: { title: "B" } },
          { card_id: "a", stage_id: "s", position_in_stage: 10, summary: { title: "A" } },
          { card_id: "c", stage_id: "other", position_in_stage: 5, summary: { title: "C" } },
        ],
        "s",
      ).map((card) => card.card_id),
    ).toEqual(["a", "b"]);
  });
});

describe("server truth over the client's mirror", () => {
  it("takes the server's can_enter answer over its own role comparison", () => {
    // The client's fallback would say "open" for both of these: no `min_role_to_enter`.
    expect(canEnterStage("sales", stage({ stage_id: "deposit", position: 5 }))).toBe(true);
    expect(
      canEnterStage("sales", stage({ stage_id: "deposit", position: 5, can_enter: false })),
    ).toBe(false);
    // And "closed" for this one, which the server nonetheless opened for this session.
    expect(
      canEnterStage(
        "sales",
        stage({ stage_id: "deposit", position: 5, min_role_to_enter: "ops", can_enter: true }),
      ),
    ).toBe(true);
  });

  it("keeps the mirror for a payload that carries no can_enter", () => {
    const restricted = stage({ stage_id: "deposit", position: 5, min_role_to_enter: "ops" });
    expect(canEnterStage("sales", restricted)).toBe(false);
    expect(canEnterStage("ops", restricted)).toBe(true);
    expect(canEnterStage("owner", restricted)).toBe(true);
  });

  it("opens on the role's own board but never hides the ones the server also returned", () => {
    const pipelines: PipelineSummary[] = [
      { pipeline_id: "pipe-shop", key: "shop", name: "Shop", owning_role: "production" },
      { pipeline_id: "pipe-sales", key: "sales", name: "Sales", owning_role: "sales" },
    ];
    expect(preferredPipeline(pipelines, "sales", null)?.pipeline_id).toBe("pipe-sales");
    // A granted board this role does not own is still reachable — selection, not filtering.
    expect(preferredPipeline(pipelines, "sales", "pipe-shop")?.pipeline_id).toBe("pipe-shop");
    // A role that owns none of them still gets a board rather than a blank screen.
    expect(preferredPipeline(pipelines, "accounting", null)?.pipeline_id).toBe("pipe-shop");
    expect(preferredPipeline([], "sales", null)).toBeUndefined();
  });

  it("reads the card version a transition leaves behind, in either payload shape", () => {
    expect(cardVersionAfterTransition({ card_version: 8 })).toBe(8);
    expect(cardVersionAfterTransition({ card: { version: 8 } })).toBe(8);
    // No version means no undo can be performed — the caller must not invent one.
    expect(cardVersionAfterTransition({})).toBeUndefined();
  });

  it("never offers Undo for longer than the server accepts it", () => {
    expect(undoWindowMs()).toBe(UNDO_WINDOW_MS);
    expect(undoWindowMs(30)).toBe(UNDO_WINDOW_MS);
    expect(undoWindowMs(2)).toBe(2_000);
    expect(undoWindowMs(Number.NaN)).toBe(UNDO_WINDOW_MS);
  });
});

describe("blockers the server actually sends", () => {
  function refusal(code: string, status: number, details: Record<string, unknown> = {}) {
    return new ApiError({ status, code, message: code, details });
  }

  it("routes a confirmation_required refusal to the confirm step, not to an error", () => {
    const blocker = describeMoveBlocker(refusal("confirmation_required", 409), {
      toStageName: "Quote Sent",
    });
    expect(blocker.outcome).toBe("confirm");
  });

  it("names the stale version the server reported", () => {
    const blocker = describeMoveBlocker(
      refusal("pipeline_card_version_conflict", 409, { card_version: 12 }),
      { toStageName: "Quote Sent" },
    );
    expect(blocker.code).toBe("pipeline_card_version_conflict");
    expect(blocker.message).toContain("version 12");
    expect(blocker.refresh).toBe(true);
  });

  it("names the stage and the role a stage refusal was about", () => {
    const blocker = describeMoveBlocker(
      refusal("stage_entry_role_required", 403, { required_role: "production" }),
      { toStageName: "Materials in prod" },
    );
    expect(blocker.message).toContain("Materials in prod");
    expect(blocker.message).toContain("production");
  });

  it("gives each transition blocker its own next step", () => {
    const cases: Array<[string, number, RegExp]> = [
      ["pipeline_move_forbidden", 403, /move permission on this pipeline/],
      ["pipeline_transition_noop", 409, /already in Quote Sent/],
      ["pipeline_entity_type_mismatch", 409, /does not belong on this board/],
      ["not_found", 404, /no longer exists on the board/],
      ["invalid_pipeline_transition", 400, /would not accept/],
      ["csrf_failed", 403, /session expired/],
    ];
    const messages = new Set<string>();
    for (const [code, status, expected] of cases) {
      const blocker = describeMoveBlocker(refusal(code, status), { toStageName: "Quote Sent" });
      expect(blocker.code, code).toBe(code);
      expect(blocker.message, code).toMatch(expected);
      messages.add(blocker.message);
    }
    // Distinct blockers, distinct copy: none of them collapses into a shared toast.
    expect(messages.size).toBe(cases.length);
  });

  it("says the card stayed put when the connection is the problem", () => {
    const offline = new ApiError({ status: 0, code: "network_error", message: "offline" });
    expect(describeMoveBlocker(offline, {}).message).toMatch(
      /No connection to IronWrap OS\. The card stayed where it was\./,
    );
  });

  it("gives each undo blocker its own next step", () => {
    const expired = describeUndoBlocker(
      refusal("pipeline_undo_window_expired", 409, { undo_window_seconds: 30 }),
      { fromStageName: "Need Quote" },
    );
    expect(expired.message).toContain("30 seconds");
    expect(expired.message).toContain("Need Quote");

    const cases: Array<[string, number, RegExp]> = [
      ["pipeline_undo_superseded", 409, /moved again since then/],
      ["pipeline_stage_changed", 409, /moved again since then/],
      ["pipeline_undo_actor_forbidden", 403, /Only the person who made this move/],
      ["pipeline_undo_not_undoable", 409, /undo cannot itself be undone/],
      ["pipeline_undo_origin_unknown", 409, /no earlier stage to return to/],
      ["pipeline_card_version_conflict", 409, /Someone else changed this card first/],
    ];
    for (const [code, status, expected] of cases) {
      const blocker = describeUndoBlocker(refusal(code, status), { fromStageName: "Need Quote" });
      expect(blocker.code, code).toBe(code);
      expect(blocker.message, code).toMatch(expected);
    }
  });

  it("still says something actionable for a blocker this build has never seen", () => {
    const blocker = describeMoveBlocker(refusal("pipeline_gate_not_cleared", 409), {
      toStageName: "Deposit",
    });
    expect(blocker.code).toBe("pipeline_gate_not_cleared");
    // The server's own message survives instead of being replaced by a category.
    expect(blocker.message).toContain("pipeline_gate_not_cleared");
    expect(blocker.message).toContain("The card stayed where it was.");
    expect(blocker.refresh).toBe(true);
  });
});

describe("optimistic move", () => {
  function board(): PipelineBoardResponse {
    return {
      version: 1,
      source_updated_at: "2026-08-22T12:00:00.000Z",
      read_model_generated_at: "2026-08-22T12:00:01.000Z",
      stale_fields: [],
      permissions: ["pipeline:read"],
      allowed_actions: ["pipeline.card.move"],
      pipeline: { pipeline_id: "pipe", key: "sales", name: "Sales" },
      stages: [
        stage({ stage_id: "need_quote", position: 2, card_count: 2, total_amount_cents: 500_000 }),
        stage({ stage_id: "quote_sent", position: 3, card_count: 1, total_amount_cents: 100_000 }),
      ],
      cards: [
        {
          card_id: "card-1",
          stage_id: "need_quote",
          position_in_stage: 10,
          summary: { title: "Naina Tamang", amount_cents: 400_000 },
        },
        {
          card_id: "card-2",
          stage_id: "need_quote",
          position_in_stage: 20,
          summary: { title: "Denym Mattson", amount_cents: 100_000 },
        },
        {
          card_id: "card-3",
          stage_id: "quote_sent",
          position_in_stage: 10,
          summary: { title: "Petre Milouchev", amount_cents: 100_000 },
        },
      ],
    };
  }

  it("moves the card and both column roll-ups with it", () => {
    const next = applyOptimisticMove(board(), "card-1", "quote_sent");
    expect(next.cards.find((card) => card.card_id === "card-1")?.stage_id).toBe("quote_sent");
    expect(next.stages.find((item) => item.stage_id === "need_quote")).toMatchObject({
      card_count: 1,
      total_amount_cents: 100_000,
    });
    expect(next.stages.find((item) => item.stage_id === "quote_sent")).toMatchObject({
      card_count: 2,
      total_amount_cents: 500_000,
    });
  });

  it("lands the moved card after the last card already in the target column", () => {
    const next = applyOptimisticMove(board(), "card-1", "quote_sent");
    expect(cardsInStage(next.cards, "quote_sent").map((card) => card.card_id)).toEqual([
      "card-3",
      "card-1",
    ]);
  });

  it("leaves the board untouched for an unknown card or a same-stage drop", () => {
    const original = board();
    expect(applyOptimisticMove(original, "missing", "quote_sent")).toBe(original);
    expect(applyOptimisticMove(original, "card-1", "need_quote")).toBe(original);
  });

  it("is its own inverse, which is what makes Undo instant", () => {
    const moved = applyOptimisticMove(board(), "card-1", "quote_sent");
    const back = applyOptimisticMove(moved, "card-1", "need_quote");
    expect(back.stages.find((item) => item.stage_id === "need_quote")).toMatchObject({
      card_count: 2,
      total_amount_cents: 500_000,
    });
    expect(back.cards.find((card) => card.card_id === "card-1")?.stage_id).toBe("need_quote");
  });
});

describe("card template binding", () => {
  const options = { locale: "en-CA", currency: "CAD" };

  it("renders the seeded sales card from the default template", () => {
    const summary: CardSummary = {
      title: "Naina Tamang",
      amount_cents: 400_000,
      identifiers: [{ label: "Lead", value: "26-219-ER" }],
      tags: ["Metal Roofing"],
      counters: [
        { kind: "messages", count: 2 },
        { kind: "files", count: 8 },
      ],
      is_won: false,
    };
    expect(cardSlots(DEFAULT_CARD_TEMPLATE, summary, options)).toEqual([
      { slot: "title", text: "Naina Tamang" },
      { slot: "value", text: formatMoneyFromCents(400_000, "en-CA", "CAD") },
      { slot: "identifiers", items: [{ label: "Lead", value: "26-219-ER" }] },
      { slot: "tags", items: ["Metal Roofing"], overflow: 0 },
      {
        slot: "counters",
        items: [
          { kind: "messages", count: 2 },
          { kind: "files", count: 8 },
        ],
      },
    ]);
  });

  // PO decision D4/D6: a fabricated $0.00 or an "Lead: <uuid>" line is worse than a
  // blank one, so a binding with nothing behind it produces no row at all.
  it("drops a slot whose source field is missing rather than inventing a value", () => {
    const slots = cardSlots(DEFAULT_CARD_TEMPLATE, { title: "Jubril Mcgregor" }, options);
    expect(slots).toEqual([{ slot: "title", text: "Jubril Mcgregor" }]);
    expect(slots.some((slot) => slot.slot === "value")).toBe(false);
    expect(slots.some((slot) => slot.slot === "identifiers")).toBe(false);
  });

  it("shows the WON badge only when the summary says so", () => {
    const won = cardSlots(DEFAULT_CARD_TEMPLATE, { title: "Petre", is_won: true }, options);
    expect(won).toContainEqual({ slot: "badge", text: "WON" });
    expect(
      cardSlots(DEFAULT_CARD_TEMPLATE, { title: "Petre", is_won: false }, options),
    ).not.toContainEqual({ slot: "badge", text: "WON" });
  });

  it("caps identifiers at two lines and collapses extra service chips", () => {
    const slots = cardSlots(
      DEFAULT_CARD_TEMPLATE,
      {
        title: "Card",
        identifiers: [
          { label: "Lead", value: "26-219-ER" },
          { label: "Job", value: "ABN26-004" },
          { label: "Extra", value: "ignored" },
        ],
        tags: ["Metal Roofing", "Soffit", "Eavestrough", "Fascia"],
      },
      options,
    );
    expect(slots).toContainEqual({
      slot: "identifiers",
      items: [
        { label: "Lead", value: "26-219-ER" },
        { label: "Job", value: "ABN26-004" },
      ],
    });
    expect(slots).toContainEqual({
      slot: "tags",
      items: ["Metal Roofing", "Soffit"],
      overflow: 2,
    });
  });

  // The generic-core test: a Production board declares a different identifier pair and
  // no services chip, and the same renderer obeys it without a component change.
  it("binds a different vertical's card from its own template", () => {
    const slots = cardSlots(
      [
        { slot: "title", source_field: "title" },
        { slot: "identifiers", source_field: "shop_identifiers", limit: 1 },
        { slot: "counters", source_field: "shop_counters" },
      ],
      {
        title: "Shop batch 12",
        amount_cents: 990_000,
        tags: ["Metal Roofing"],
        shop_identifiers: [{ label: "Work order", value: "WO-88" }],
        shop_counters: [{ kind: "tasks", count: 4 }],
      },
      options,
    );
    expect(slots).toEqual([
      { slot: "title", text: "Shop batch 12" },
      { slot: "identifiers", items: [{ label: "Work order", value: "WO-88" }] },
      { slot: "counters", items: [{ kind: "tasks", count: 4 }] },
    ]);
  });

  it("skips a slot kind this build does not know instead of failing the card", () => {
    const slots = cardSlots(
      [
        { slot: "sparkline", source_field: "trend" },
        { slot: "title", source_field: "title" },
      ],
      { title: "Card", trend: [1, 2, 3] },
      options,
    );
    expect(slots).toEqual([{ slot: "title", text: "Card" }]);
  });

  it("renders a stage roll-up only when the server sent one", () => {
    expect(
      stageRollUp(
        stage({ stage_id: "s", position: 0, total_amount_cents: 641_420_540 }),
        "en-CA",
        "CAD",
      ),
    ).toContain("6,414,205.40");
    expect(
      stageRollUp(stage({ stage_id: "s", position: 0, total_amount_cents: null }), "en-CA", "CAD"),
    ).toBeNull();
  });
});
