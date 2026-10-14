// pipeline-board-api.test.ts - the safe-movement contract, proved at the API (IRO-209).
//
// Every row of the PO's safeguard matrix (decision D2) is exercised through the real route handler
// against a real database. A UI-only safeguard fails this issue outright, so nothing here asserts
// what a component would do: each case asserts what the SERVER did or refused, and what the
// append-only audit trail says afterwards.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { handlePipelineRoute } from "../src/pipeline-board-api.ts";
import { PIPELINE_UNDO_WINDOW_MS } from "../src/pipeline-board.ts";
import {
  auth,
  request,
  setup,
  SALES_PIPELINE_ID,
  stageId,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const MOVE_TIME = new Date("2026-08-22T13:00:00.000Z");
const BOARD = `/api/v1/pipelines/${SALES_PIPELINE_ID}`;

async function call(
  harness: Harness,
  req: Request,
  who: Parameters<typeof auth>[0] = "sales",
  now: Date = MOVE_TIME,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handlePipelineRoute(req, harness.env, auth(who), now);
  assert.ok(response, `route did not claim ${req.method} ${new URL(req.url).pathname}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Places a card and leaves it in `stageKey`, returning its id and current version. */
async function cardIn(
  harness: Harness,
  stageKey: string,
  options: { leadId?: string; key?: string } = {},
): Promise<{ cardId: string; version: number }> {
  const placed = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: {
        entity_type: "lead",
        entity_id: options.leadId ?? "lead:board:0001",
        stage_key: stageKey,
      },
      idempotency: options.key ?? `place-${stageKey}-000000001`,
    }),
    "owner",
  );
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  return { cardId: String(placed.body.card_id), version: Number(placed.body.card_version) };
}

function move(
  cardId: string,
  toStageKey: string,
  version: number,
  options: { confirmed?: boolean; reasonCode?: string; key?: string } = {},
): Request {
  return request("POST", `${BOARD}/cards/${cardId}/transitions`, {
    body: {
      to_stage_id: stageId(toStageKey),
      expected_version: version,
      ...(options.confirmed === undefined ? {} : { confirmed: options.confirmed }),
      ...(options.reasonCode === undefined ? {} : { reason_code: options.reasonCode }),
    },
    idempotency: options.key ?? `move-${toStageKey}-000000001`,
  });
}

function transitions(harness: Harness, cardId: string): Record<string, unknown>[] {
  return harness.db.raw
    .prepare(
      `SELECT * FROM pipeline_card_transitions
        WHERE tenant_id = ? AND card_id = ?
        ORDER BY card_version ASC, transition_id ASC`,
    )
    .all(TENANT, cardId) as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ safeguard matrix ---- */

test("D2 row 1: a forward-by-one move commits directly, with no confirmed flag", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.safeguard, "direct");
  assert.equal(moved.body.to_stage_id, stageId("visit_booked"));
  assert.equal(moved.body.card_version, card.version + 1);
  harness.db.close();
});

test("D2 row 2: a forward-by-one move INTO the won stage is still direct, no dialog", async () => {
  const harness = setup();
  const card = await cardIn(harness, "quote_sent");
  const moved = await call(harness, move(card.cardId, "contract_signed", card.version));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.safeguard, "direct");
  const wonStage = harness.db.raw
    .prepare(`SELECT is_won FROM pipeline_stages WHERE stage_id = ?`)
    .get(stageId("contract_signed")) as { is_won: number };
  assert.equal(wonStage.is_won, 1, "the seeded won stage is the one this case moved into");
  harness.db.close();
});

test("D2 row 3: a backward move is refused with 409 confirmation_required and commits nothing", async () => {
  const harness = setup();
  const card = await cardIn(harness, "quote_sent");
  const refused = await call(harness, move(card.cardId, "new_lead", card.version));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "confirmation_required");
  assert.equal(refused.body.jump, "backward");
  assert.equal((refused.body.to_stage as Record<string, unknown>).key, "new_lead");
  assert.deepEqual(transitions(harness, card.cardId).map((row) => row.safeguard), ["direct"]);
  const after = harness.db.raw
    .prepare(`SELECT stage_id, version FROM pipeline_cards WHERE card_id = ?`)
    .get(card.cardId) as { stage_id: string; version: number };
  assert.equal(after.stage_id, stageId("quote_sent"), "a refused move must not move the card");
  assert.equal(after.version, card.version);
  harness.db.close();
});

test("D2 row 3: the same backward move commits once confirmed, recorded as 'confirmed'", async () => {
  const harness = setup();
  const card = await cardIn(harness, "quote_sent");
  const confirmed = await call(
    harness,
    move(card.cardId, "new_lead", card.version, { confirmed: true }),
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.safeguard, "confirmed");
  harness.db.close();
});

test("D2 row 4: a skip-ahead move is refused, then commits when confirmed", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const refused = await call(harness, move(card.cardId, "quote_sent", card.version));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "confirmation_required");
  assert.equal(refused.body.jump, "skip");

  const confirmed = await call(
    harness,
    move(card.cardId, "quote_sent", card.version, { confirmed: true, key: "skip-000000000002" }),
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.safeguard, "confirmed");
  harness.db.close();
});

test("D2 row 5: a role-restricted stage refuses the wrong role with 403 and confirms the right one", async () => {
  const harness = setup();
  // An administrator restricting a stage is M3 configuration; the column is written directly here
  // because M1 ships no admin UI for it, which is exactly what the deferred list says.
  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET min_role_to_enter = 'production', version = version + 1,
              updated_at = '2026-08-22T12:30:00.000Z'
        WHERE stage_id = ?`,
    )
    .run(stageId("materials_in_prod"));
  const card = await cardIn(harness, "deposit");

  const refusedForSales = await call(
    harness,
    move(card.cardId, "materials_in_prod", card.version, { confirmed: true }),
    "sales",
  );
  assert.equal(refusedForSales.status, 403);
  assert.equal(refusedForSales.body.error, "stage_entry_role_required");
  assert.equal(refusedForSales.body.required_role, "production");

  // The owner satisfies any stage role, but a restricted stage still asks for a confirmation even
  // though this is an adjacent-forward move.
  const unconfirmed = await call(
    harness,
    move(card.cardId, "materials_in_prod", card.version, { key: "restricted-00000001" }),
    "owner",
  );
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.jump, "restricted");

  const confirmed = await call(
    harness,
    move(card.cardId, "materials_in_prod", card.version, {
      confirmed: true,
      key: "restricted-00000002",
    }),
    "owner",
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.safeguard, "confirmed");
  harness.db.close();
});

test("D2 row 6: a role with no move rights on the pipeline is refused by the API", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");

  // ops reads every board and moves nothing on it, the posture it already holds on the production
  // runway and the money desk.
  const opsAttempt = await call(harness, move(card.cardId, "visit_booked", card.version), "ops");
  assert.equal(opsAttempt.status, 403);
  assert.equal(opsAttempt.body.error, "pipeline_move_forbidden");

  // production does not own the Sales pipeline, so the board is not even discoverable to it.
  const productionAttempt = await call(
    harness,
    move(card.cardId, "visit_booked", card.version),
    "production",
  );
  assert.equal(productionAttempt.status, 404);

  assert.deepEqual(transitions(harness, card.cardId).map((row) => row.safeguard), ["direct"]);
  harness.db.close();
});

test("a move to the stage the card is already in is refused rather than audited as a no-op", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const same = await call(harness, move(card.cardId, "new_lead", card.version));
  assert.equal(same.status, 409);
  assert.equal(same.body.error, "pipeline_transition_noop");
  harness.db.close();
});

test("a stale expected_version is refused and leaves no audit row behind", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  await call(harness, move(card.cardId, "visit_booked", card.version));
  const stale = await call(
    harness,
    move(card.cardId, "need_quote", card.version, { key: "stale-0000000000001" }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "pipeline_card_version_conflict");
  assert.equal(transitions(harness, card.cardId).length, 2, "placement plus the one real move");
  harness.db.close();
});

/* ------------------------------------------------------------------------------- undo ---- */

test("undo inside the 30s window returns the card and appends an 'undo' row, never a delete", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));

  const undone = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-00000000000001",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 29_000),
  );
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.safeguard, "undo");
  assert.equal(undone.body.to_stage_id, stageId("new_lead"));
  assert.equal(undone.body.correlation_id, moved.body.transition_id);

  const trail = transitions(harness, card.cardId);
  assert.deepEqual(trail.map((row) => row.safeguard), ["direct", "direct", "undo"]);
  assert.equal(
    trail.at(-1)?.correlation_id,
    moved.body.transition_id,
    "the undo row points back at the transition it reverses",
  );
  const after = harness.db.raw
    .prepare(`SELECT stage_id FROM pipeline_cards WHERE card_id = ?`)
    .get(card.cardId) as { stage_id: string };
  assert.equal(after.stage_id, stageId("new_lead"));
  harness.db.close();
});

test("undo refuses an origin stage archived after the move", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  // The original stage has history, so the real admin route archives it rather than deleting it.
  const removed = await handlePipelineRoute(
    request("POST", `/api/v1/admin/pipelines/${SALES_PIPELINE_ID}/stages/${stageId("new_lead")}/remove`, {
      body: { expected_version: 1 },
      idempotency: "archive-origin-stage-0001",
    }),
    harness.env,
    auth("owner"),
    MOVE_TIME,
  );
  assert.ok(removed);
  assert.equal(removed.status, 200, await removed.text());

  const undo = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-archived-origin-0001",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(undo.status, 409, JSON.stringify(undo.body));
  assert.equal(undo.body.error, "pipeline_stage_changed");

  const after = harness.db.raw
    .prepare(`SELECT stage_id, version, last_transition_id FROM pipeline_cards WHERE card_id = ?`)
    .get(card.cardId) as { stage_id: string; version: number; last_transition_id: string };
  assert.deepEqual({ ...after }, {
    stage_id: stageId("visit_booked"),
    version: Number(moved.body.card_version),
    last_transition_id: moved.body.transition_id,
  });
  assert.equal(transitions(harness, card.cardId).length, 2, "undo must not append a row");
  harness.db.close();
});

test("undo outside the 30s window is refused and the move stands", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));

  const late = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-00000000000002",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + PIPELINE_UNDO_WINDOW_MS + 1_000),
  );
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "pipeline_undo_window_expired");
  assert.deepEqual(transitions(harness, card.cardId).map((row) => row.safeguard), [
    "direct",
    "direct",
  ]);
  harness.db.close();
});

test("undo by an actor who did not make the move is refused; the owner may still take it back", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));
  const undoRequest = (key: string) =>
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: key,
    });

  const stranger = await call(
    harness,
    undoRequest("undo-00000000000003"),
    "sales_other",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, "pipeline_undo_actor_forbidden");

  const owner = await call(
    harness,
    undoRequest("undo-00000000000004"),
    "owner",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  harness.db.close();
});

test("undo replay binds the actor and expected version", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));
  const undoPath = `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`;
  const first = await call(
    harness,
    request("POST", undoPath, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-semantic-0001",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const changedActor = await call(
    harness,
    request("POST", undoPath, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-semantic-0001",
    }),
    "owner",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(changedActor.status, 409);
  assert.equal(changedActor.body.error, "pipeline_transition_idempotency_conflict");

  const changedVersion = await call(
    harness,
    request("POST", undoPath, {
      body: { expected_version: Number(moved.body.card_version) + 1 },
      idempotency: "undo-semantic-0001",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(changedVersion.status, 409);
  assert.equal(changedVersion.body.error, "pipeline_transition_idempotency_conflict");
  harness.db.close();
});

test("undo of a superseded transition is refused once the card has moved on", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const first = await call(harness, move(card.cardId, "visit_booked", card.version));
  await call(
    harness,
    move(card.cardId, "need_quote", Number(first.body.card_version), { key: "second-000000001" }),
  );

  const stale = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${first.body.transition_id}/undo`, {
      body: { expected_version: Number(first.body.card_version) + 1 },
      idempotency: "undo-00000000000005",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 5_000),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "pipeline_undo_superseded");
  harness.db.close();
});

/* ------------------------------------------------------------------------- audit trail ---- */

test("every committed move writes exactly one audit row and one automation-outbox row", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const moved = await call(harness, move(card.cardId, "visit_booked", card.version));
  await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions/${moved.body.transition_id}/undo`, {
      body: { expected_version: Number(moved.body.card_version) },
      idempotency: "undo-00000000000006",
    }),
    "sales",
    new Date(MOVE_TIME.getTime() + 1_000),
  );

  const trail = transitions(harness, card.cardId);
  assert.equal(trail.length, 3);
  const outbox = harness.db.raw
    .prepare(
      `SELECT transition_id, status FROM pipeline_stage_automation_outbox
        WHERE tenant_id = ? AND card_id = ? ORDER BY created_at ASC, outbox_id ASC`,
    )
    .all(TENANT, card.cardId) as Array<{ transition_id: string; status: string }>;
  assert.equal(outbox.length, 3, "placement, move and undo each hand M4 one row");
  assert.deepEqual(
    outbox.map((row) => row.status),
    ["pending", "pending", "pending"],
    "no consumer exists yet, so nothing drains the outbox",
  );
  assert.deepEqual(
    outbox.map((row) => row.transition_id).sort(),
    trail.map((row) => String(row.transition_id)).sort(),
  );
  harness.db.close();
});

test("replaying an idempotency key returns the original transition instead of moving twice", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  const first = await call(harness, move(card.cardId, "visit_booked", card.version));
  const replay = await call(harness, move(card.cardId, "visit_booked", card.version));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.transition_id, first.body.transition_id);
  assert.equal(transitions(harness, card.cardId).length, 2);
  harness.db.close();
});

test("reusing an idempotency key for a different move is refused outright", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  await call(harness, move(card.cardId, "visit_booked", card.version, { key: "shared-000000001" }));
  const reused = await call(
    harness,
    move(card.cardId, "need_quote", card.version + 1, { confirmed: true, key: "shared-000000001" }),
  );
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "pipeline_transition_idempotency_conflict");
  harness.db.close();
});

test("a replay key is bound to reason, raw confirmation, and actor", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  await call(
    harness,
    move(card.cardId, "visit_booked", card.version, {
      reasonCode: "routine_move",
      key: "semantic-shared-0001",
    }),
  );

  const changedReason = await call(
    harness,
    move(card.cardId, "visit_booked", card.version, {
      reasonCode: "different_reason",
      key: "semantic-shared-0001",
    }),
  );
  assert.equal(changedReason.status, 409);
  assert.equal(changedReason.body.error, "pipeline_transition_idempotency_conflict");

  const changedActor = await call(
    harness,
    move(card.cardId, "visit_booked", card.version, {
      reasonCode: "routine_move",
      key: "semantic-shared-0001",
    }),
    "owner",
  );
  assert.equal(changedActor.status, 409);
  assert.equal(changedActor.body.error, "pipeline_transition_idempotency_conflict");
  harness.db.close();
});

test("raw confirmation semantics are part of a replay key", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");
  await call(
    harness,
    move(card.cardId, "quote_sent", card.version, {
      confirmed: true,
      key: "confirmation-shared-001",
    }),
  );
  const changedConfirmation = await call(
    harness,
    move(card.cardId, "quote_sent", card.version, {
      confirmed: false,
      key: "confirmation-shared-001",
    }),
  );
  assert.equal(changedConfirmation.status, 409);
  assert.equal(changedConfirmation.body.error, "pipeline_transition_idempotency_conflict");
  harness.db.close();
});

/* --------------------------------------------------------------------- request hygiene ---- */

test("a move without CSRF or without an idempotency key never reaches the safeguard matrix", async () => {
  const harness = setup();
  const card = await cardIn(harness, "new_lead");

  const noCsrf = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions`, {
      body: { to_stage_id: stageId("visit_booked"), expected_version: card.version },
      csrf: false,
    }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const noKey = await call(
    harness,
    request("POST", `${BOARD}/cards/${card.cardId}/transitions`, {
      body: { to_stage_id: stageId("visit_booked"), expected_version: card.version },
      idempotency: null,
    }),
  );
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "idempotency_key_required");
  harness.db.close();
});

/* --------------------------------------------------------------------- card placement ---- */

test("a card can only bind to an entity that exists in this tenant", async () => {
  const harness = setup();
  const ghost = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "lead", entity_id: "lead:board:9999" },
      idempotency: "place-ghost-00000001",
    }),
    "owner",
  );
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error, "pipeline_entity_not_found");

  const unknownType = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "unicorn", entity_id: "lead:board:0001" },
      idempotency: "place-unicorn-0000001",
    }),
    "owner",
  );
  assert.equal(unknownType.status, 400);
  assert.equal(unknownType.body.error, "invalid_pipeline_card");

  const wrongKind = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "job", entity_id: "job:board:0001" },
      idempotency: "place-job-000000001",
    }),
    "owner",
  );
  assert.equal(wrongKind.status, 409);
  assert.equal(wrongKind.body.error, "pipeline_entity_type_mismatch");
  harness.db.close();
});

test("placing the same entity twice returns the existing card rather than duplicating it", async () => {
  const harness = setup();
  const first = await cardIn(harness, "new_lead");
  const again = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "lead", entity_id: "lead:board:0001" },
      idempotency: "place-again-00000001",
    }),
    "owner",
  );
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.card_id, first.cardId);
  harness.db.close();
});

test("placement cannot reuse a key for a different destination", async () => {
  const harness = setup();
  const first = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "lead", entity_id: "lead:board:0001", stage_key: "new_lead" },
      idempotency: "placement-shared-001",
    }),
    "owner",
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const changed = await call(
    harness,
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "lead", entity_id: "lead:board:0001", stage_key: "visit_booked" },
      idempotency: "placement-shared-001",
    }),
    "owner",
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "pipeline_transition_idempotency_conflict");
  harness.db.close();
});

/* ------------------------------------------------------------------------ mount point ---- */

test("the board is reachable through the authenticated app router, not only its sub-router", async () => {
  const harness = setup();
  await cardIn(harness, "new_lead");
  const response = await handleAuthenticatedRoute(
    request("GET", `${BOARD}/board`, { idempotency: null }),
    harness.env,
    auth("sales"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal((body.pipeline as Record<string, unknown>).key, "sales");
  harness.db.close();
});

test("an authenticated app POST commits the New Lead to Visit Booked transition", async () => {
  const harness = setup();
  try {
    const card = await cardIn(harness, "new_lead");
    const response = await handleAuthenticatedRoute(
      move(card.cardId, "visit_booked", card.version),
      harness.env,
      auth("sales"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.from_stage_id, stageId("new_lead"));
    assert.equal(body.to_stage_id, stageId("visit_booked"));
    assert.equal(body.safeguard, "direct");
    assert.equal(body.card_version, card.version + 1);
    const stored = harness.db.raw
      .prepare("SELECT stage_id, version FROM pipeline_cards WHERE card_id = ?")
      .get(card.cardId);
    assert.deepEqual({ ...stored }, { stage_id: stageId("visit_booked"), version: card.version + 1 });
    assert.equal(transitions(harness, card.cardId).at(-1)?.transition_id, body.transition_id);
  } finally {
    harness.db.close();
  }
});
