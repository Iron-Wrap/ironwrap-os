// pipeline-board-read.test.ts - the mobile-first board payload (IRO-209).
//
// The board endpoint is what a phone renders a horizontal Kanban from in one request, so what is
// asserted here is the SHAPE: envelope fields, stage roll-ups summed server-side, and a per-card
// summary produced from the pipeline's own card template rather than a per-vertical field list.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handlePipelineRoute } from "../src/pipeline-board-api.ts";
import {
  auth,
  request,
  setup,
  SALES_PIPELINE_ID,
  SEED_TIME,
  stageId,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const BOARD = `/api/v1/pipelines/${SALES_PIPELINE_ID}`;

async function read(
  harness: Harness,
  path: string,
  who: Parameters<typeof auth>[0] = "sales",
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request("GET", path, { idempotency: null }),
    harness.env,
    auth(who),
  );
  assert.ok(response, `route did not claim GET ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function place(
  harness: Harness,
  leadId: string,
  stageKey: string,
  key: string,
): Promise<string> {
  const response = await handlePipelineRoute(
    request("POST", `${BOARD}/cards`, {
      body: { entity_type: "lead", entity_id: leadId, stage_key: stageKey },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
  );
  assert.ok(response);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 201, JSON.stringify(body));
  return String(body.card_id);
}

test("the board carries the read-model envelope plus one flat card list, no nested stages", async () => {
  const harness = setup();
  await place(harness, "lead:board:0001", "quote_sent", "read-000000000001");
  const { status, body } = await read(harness, `${BOARD}/board`);
  assert.equal(status, 200);

  for (const field of [
    "version",
    "source_updated_at",
    "read_model_generated_at",
    "stale_fields",
    "permissions",
    "allowed_actions",
  ])
    assert.ok(Object.hasOwn(body, field), `envelope is missing ${field}`);
  assert.equal(body.pipeline.key, "sales");
  assert.equal(body.stages.length, 7);
  assert.equal(body.undo_window_seconds, 30);
  assert.ok(body.allowed_actions.includes("pipeline.card.move"));
  // Flat: a card names its stage by id and carries no nested stage object for a phone to walk.
  assert.equal(Object.hasOwn(body.cards[0], "stage"), false);
  assert.equal(body.cards[0].stage_id, stageId("quote_sent"));
  // The board surface renders slots from the template, so it travels with the board payload and
  // the client never re-parses the stored JSON. It carries a card version for the safe-move CAS.
  assert.deepEqual(
    body.pipeline.card_template.slots.map((slot: any) => slot.slot),
    ["title", "amount", "identifier", "tag", "won_flag"],
  );
  assert.equal(body.cards[0].version, 1);
  harness.db.close();
});

test("the pipeline list omits the card template - a switcher never renders a card", async () => {
  const harness = setup();
  const { body } = await read(harness, "/api/v1/pipelines");
  assert.equal(Object.hasOwn(body.pipelines[0], "card_template"), false);
  harness.db.close();
});

test("a card's value, identifier and services come from the template, and the won flag from its stage", async () => {
  const harness = setup();
  await place(harness, "lead:board:0001", "contract_signed", "read-000000000002");
  const { body } = await read(harness, `${BOARD}/board`);
  const card = body.cards.find((entry: any) => entry.entity_id === "lead:board:0001");

  assert.equal(card.summary.title, "Naina Tamang");
  // PO decision D4: the estimate is the first value source.
  assert.equal(card.summary.amount_cents, 400_000);
  assert.deepEqual(card.summary.identifiers, [{ label: "Job", value: "ABN26-007" }]);
  assert.deepEqual(card.summary.tags, ["Metal Roofing"]);
  assert.deepEqual(card.summary.counters, [], "no counter source exists in the system yet");
  assert.equal(card.summary.is_won, true, "the card sits in the stage flagged won");
  harness.db.close();
});

test("a card with no value anywhere carries no amount_cents at all, never a fabricated zero", async () => {
  const harness = setup();
  await place(harness, "lead:board:0002", "new_lead", "read-000000000003");
  const { body } = await read(harness, `${BOARD}/board`);
  const card = body.cards.find((entry: any) => entry.entity_id === "lead:board:0002");

  assert.equal(card.summary.title, "Bare Lead");
  assert.equal(
    Object.hasOwn(card.summary, "amount_cents"),
    false,
    "PO decision D4: no $ field before Need Quote, and a blank line beats a fake $0.00",
  );
  assert.deepEqual(card.summary.identifiers, [], "no job number yet, so no Job line");
  assert.deepEqual(card.summary.tags, []);
  harness.db.close();
});

test("the value falls back to the customer quote when a lead has no instant estimate", async () => {
  const harness = setup();
  harness.db.raw.prepare(`DELETE FROM operating_instant_estimates WHERE tenant_id = ?`).run(TENANT);
  const hex = (seed: string) => seed.repeat(64).slice(0, 64);
  harness.db.raw
    .prepare(
      `INSERT INTO commercial_authority_permits
         (permit_id, tenant_id, policy_id, policy_version, policy_digest, policy_snapshot_json,
          action, actor_type, actor_id, aggregate_type, aggregate_id, aggregate_version,
          amount_cents, command_fingerprint, facts_digest, evidence_refs_json, evidence_digest,
          idempotency_key_hash, request_fingerprint, issued_at, expires_at)
       VALUES ('permit:board:quote:00000000000001', ?, 'commercial.quote', 'v1', ?, '{}',
               'quote.revision.record', 'owner', 'appu_owner_0001', 'customer_quote',
               'customer-quote:board:0001', 1, 945000, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    )
    .run(
      TENANT,
      hex("a"),
      hex("b"),
      hex("c"),
      hex("d"),
      hex("e"),
      hex("f"),
      SEED_TIME,
      "2026-12-31T00:00:00.000Z",
    );
  harness.db.raw
    .prepare(
      `INSERT INTO commercial_quote_revisions
         (quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
          customer_id, supersedes_quote_revision_id, status, currency, valid_until,
          subtotal_cents, tax_cents, total_cents, terms_json, terms_hash, evidence_refs_json,
          evidence_digest, correction_reason, policy_permit_id, authority_evidence_digest,
          command_fingerprint, idempotency_key_hash, created_at)
       VALUES ('quote-revision:board:0001', ?, 'customer-quote:board:0001', 1, 'job:board:0001',
               'customer:board:0001', NULL, 'approved', 'CAD', '2026-12-31',
               900000, 45000, 945000, '{}', ?, '[]', ?, NULL,
               'permit:board:quote:00000000000001', ?, ?, ?, ?)`,
    )
    // The authority guard requires the quote to carry the very fingerprints its permit was
    // issued against, so these two are the permit's values, not fresh ones.
    .run(TENANT, hex("1"), hex("2"), hex("d"), hex("b"), hex("5"), SEED_TIME);

  await place(harness, "lead:board:0001", "quote_sent", "read-000000000004");
  const { body } = await read(harness, `${BOARD}/board`);
  const card = body.cards.find((entry: any) => entry.entity_id === "lead:board:0001");
  assert.equal(card.summary.amount_cents, 945_000);
  harness.db.close();
});

test("stage roll-ups are summed server-side so a phone never adds up a column itself", async () => {
  const harness = setup();
  await place(harness, "lead:board:0001", "quote_sent", "read-000000000005");
  await place(harness, "lead:board:0002", "quote_sent", "read-000000000006");
  const { body } = await read(harness, `${BOARD}/board`);

  const quoteSent = body.stages.find((stage: any) => stage.key === "quote_sent");
  assert.equal(quoteSent.card_count, 2);
  assert.equal(
    quoteSent.total_amount_cents,
    400_000,
    "the valueless card contributes nothing rather than distorting the roll-up",
  );
  const newLead = body.stages.find((stage: any) => stage.key === "new_lead");
  assert.equal(newLead.card_count, 0);
  assert.equal(newLead.total_amount_cents, 0);
  const won = body.stages.find((stage: any) => stage.key === "contract_signed");
  assert.equal(won.is_won, true);
  assert.equal(body.stages.filter((stage: any) => stage.is_lost).length, 0);
  harness.db.close();
});

test("stage entry rights travel with the board so the client can grey a locked column", async () => {
  const harness = setup();
  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET min_role_to_enter = 'production', version = version + 1,
              updated_at = ? WHERE stage_id = ?`,
    )
    .run("2026-08-22T12:30:00.000Z", stageId("materials_in_prod"));

  const forSales = await read(harness, `${BOARD}/board`, "sales");
  const lockedForSales = forSales.body.stages.find((stage: any) => stage.key === "materials_in_prod");
  assert.equal(lockedForSales.min_role_to_enter, "production");
  assert.equal(lockedForSales.can_enter, false);

  const forOwner = await read(harness, `${BOARD}/board`, "owner");
  const lockedForOwner = forOwner.body.stages.find((stage: any) => stage.key === "materials_in_prod");
  assert.equal(lockedForOwner.can_enter, true);
  harness.db.close();
});

test("board visibility is role-scoped through the pipeline's owning role", async () => {
  const harness = setup();

  const forOps = await read(harness, `${BOARD}/board`, "ops");
  assert.equal(forOps.status, 200, "ops reads every board");
  assert.equal(forOps.body.pipeline.can_move, false, "and moves nothing on it");
  assert.equal(forOps.body.allowed_actions.includes("pipeline.card.move"), false);

  const forSales = await read(harness, `${BOARD}/board`, "sales");
  assert.equal(forSales.body.pipeline.can_move, true);

  // production does not own the Sales pipeline: the board is not discoverable, not merely refused.
  assert.equal((await read(harness, `${BOARD}/board`, "production")).status, 404);
  // A crew member's surface is their task list, never a Sales pipeline.
  const forField = await read(harness, `${BOARD}/board`, "field");
  assert.equal(forField.status, 403);
  assert.equal(forField.body.error, "pipeline_read_forbidden");
  harness.db.close();
});

test("the pipeline list is scoped the same way and carries a card count per board", async () => {
  const harness = setup();
  await place(harness, "lead:board:0001", "new_lead", "read-000000000007");

  const forSales = await read(harness, "/api/v1/pipelines", "sales");
  assert.equal(forSales.status, 200);
  assert.equal(forSales.body.pipelines.length, 1);
  assert.equal(forSales.body.pipelines[0].key, "sales");
  assert.equal(forSales.body.pipelines[0].entity_type, "lead");
  assert.equal(forSales.body.pipelines[0].card_count, 1);
  assert.equal(forSales.body.pipelines[0].can_move, true);

  const forProduction = await read(harness, "/api/v1/pipelines", "production");
  assert.equal(forProduction.status, 200);
  assert.deepEqual(forProduction.body.pipelines, [], "a board it does not own is not listed");

  const forField = await read(harness, "/api/v1/pipelines", "field");
  assert.equal(forField.status, 403);
  harness.db.close();
});

test("an unknown pipeline id is a plain 404 rather than a probe oracle", async () => {
  const harness = setup();
  assert.equal((await read(harness, "/api/v1/pipelines/pl_nope0000/board")).status, 404);
  harness.db.close();
});
