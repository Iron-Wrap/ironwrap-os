import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commitCardTransition,
  getCard,
  placeCard,
  PipelineStoreError,
  resolveCardRelations,
} from "../src/pipeline-board-store.ts";
import {
  SALES_PIPELINE_ID,
  SEED_TIME,
  setup,
  stageId,
  TENANT,
} from "./pipeline-board-fixture.ts";

test("a stale same-destination writer cannot append an audit or outbox row", async () => {
  const harness = setup();
  const placed = await placeCard(harness.env, {
    tenantId: TENANT,
    pipelineId: SALES_PIPELINE_ID,
    stageId: stageId("new_lead"),
    entityType: "lead",
    entityId: "lead:board:0001",
    actorType: "worker",
    actorId: "appu_sales_0001",
    idempotencyKey: "store-place-000001",
  });
  const staleCard = await getCard(harness.env, TENANT, SALES_PIPELINE_ID, placed.card.card_id);
  assert.ok(staleCard);

  await commitCardTransition(
    harness.env,
    {
      tenantId: TENANT,
      pipelineId: SALES_PIPELINE_ID,
      card: staleCard,
      toStageId: stageId("visit_booked"),
      expectedVersion: staleCard.version,
      safeguard: "direct",
      reasonCode: null,
      correlationId: null,
      actorType: "worker",
      actorId: "appu_sales_0001",
      idempotencyKey: "store-first-000001",
      rawConfirmation: null,
      undoTransitionId: null,
    },
    new Date(SEED_TIME),
  );

  await assert.rejects(
    commitCardTransition(
      harness.env,
      {
        tenantId: TENANT,
        pipelineId: SALES_PIPELINE_ID,
        card: staleCard,
        toStageId: stageId("visit_booked"),
        expectedVersion: staleCard.version,
        safeguard: "direct",
        reasonCode: null,
        correlationId: null,
        actorType: "worker",
        actorId: "appu_sales_0002",
        idempotencyKey: "store-stale-000001",
        rawConfirmation: null,
        undoTransitionId: null,
      },
      new Date(SEED_TIME),
    ),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_card_version_conflict",
  );

  const auditCount = harness.db.raw
    .prepare(`SELECT COUNT(*) AS count FROM pipeline_card_transitions WHERE tenant_id = ? AND card_id = ?`)
    .get(TENANT, staleCard.card_id) as { count: number };
  const outboxCount = harness.db.raw
    .prepare(`SELECT COUNT(*) AS count FROM pipeline_stage_automation_outbox WHERE tenant_id = ? AND card_id = ?`)
    .get(TENANT, staleCard.card_id) as { count: number };
  assert.equal(auditCount.count, 2, "placement plus the winning move only");
  assert.equal(outboxCount.count, 2, "placement plus the winning move only");
  const current = harness.db.raw
    .prepare(`SELECT stage_id, version FROM pipeline_cards WHERE card_id = ?`)
    .get(staleCard.card_id) as { stage_id: string; version: number };
  assert.equal(current.stage_id, stageId("visit_booked"));
  assert.equal(current.version, staleCard.version + 1);
  harness.db.close();
});

test("card placement is rejected atomically when the pipeline or destination stage is inactive", async () => {
  const harness = setup();
  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET is_active = 0, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND stage_id = ?`,
    )
    .run(SEED_TIME, TENANT, stageId("visit_booked"));

  await assert.rejects(
    placeCard(harness.env, {
      tenantId: TENANT,
      pipelineId: SALES_PIPELINE_ID,
      stageId: stageId("visit_booked"),
      entityType: "lead",
      entityId: "lead:board:0001",
      actorType: "worker",
      actorId: "appu_sales_0001",
      idempotencyKey: "store-inactive-stage-001",
    }),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_stage_changed",
  );
  assert.equal(
    (harness.db.raw.prepare(`SELECT COUNT(*) AS count FROM pipeline_cards`).get() as { count: number }).count,
    0,
  );
  assert.equal(
    (harness.db.raw.prepare(`SELECT COUNT(*) AS count FROM pipeline_card_transitions`).get() as { count: number }).count,
    0,
  );
  assert.equal(
    (harness.db.raw.prepare(`SELECT COUNT(*) AS count FROM pipeline_stage_automation_outbox`).get() as { count: number }).count,
    0,
  );

  // The same database boundary also rejects an inactive pipeline even when both stage rows remain
  // active; the route's earlier visibility check is not the authority for this write.
  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET is_active = 1, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND stage_id = ?`,
    )
    .run(SEED_TIME, TENANT, stageId("visit_booked"));
  harness.db.raw
    .prepare(
      `UPDATE pipelines SET is_active = 0, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND pipeline_id = ?`,
    )
    .run(SEED_TIME, TENANT, SALES_PIPELINE_ID);
  await assert.rejects(
    placeCard(harness.env, {
      tenantId: TENANT,
      pipelineId: SALES_PIPELINE_ID,
      stageId: stageId("new_lead"),
      entityType: "lead",
      entityId: "lead:board:0002",
      actorType: "worker",
      actorId: "appu_sales_0001",
      idempotencyKey: "store-inactive-pipeline-001",
    }),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_stage_changed",
  );
  assert.equal(
    (harness.db.raw.prepare(`SELECT COUNT(*) AS count FROM pipeline_cards`).get() as { count: number }).count,
    0,
  );
  harness.db.close();
});

test("card movement and undo cannot target an inactive stage at the database boundary", async () => {
  const harness = setup();
  const placed = await placeCard(harness.env, {
    tenantId: TENANT,
    pipelineId: SALES_PIPELINE_ID,
    stageId: stageId("new_lead"),
    entityType: "lead",
    entityId: "lead:board:0001",
    actorType: "worker",
    actorId: "appu_sales_0001",
    idempotencyKey: "store-active-move-place-001",
  });
  const card = await getCard(harness.env, TENANT, SALES_PIPELINE_ID, placed.card.card_id);
  assert.ok(card);

  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET is_active = 0, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND stage_id = ?`,
    )
    .run(SEED_TIME, TENANT, stageId("visit_booked"));
  const before = await getCard(harness.env, TENANT, SALES_PIPELINE_ID, card.card_id);
  const beforeTransitions = harness.db.raw
    .prepare(`SELECT * FROM pipeline_card_transitions WHERE card_id = ? ORDER BY card_version`)
    .all(card.card_id);
  const beforeOutbox = harness.db.raw
    .prepare(`SELECT * FROM pipeline_stage_automation_outbox WHERE card_id = ? ORDER BY created_at`)
    .all(card.card_id);

  await assert.rejects(
    commitCardTransition(
      harness.env,
      {
        tenantId: TENANT,
        pipelineId: SALES_PIPELINE_ID,
        card,
        toStageId: stageId("visit_booked"),
        expectedVersion: card.version,
        safeguard: "direct",
        reasonCode: null,
        correlationId: null,
        actorType: "worker",
        actorId: "appu_sales_0001",
        idempotencyKey: "store-inactive-target-001",
        rawConfirmation: null,
        undoTransitionId: null,
      },
      new Date(SEED_TIME),
    ),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_stage_changed",
  );
  assert.deepEqual(
    await getCard(harness.env, TENANT, SALES_PIPELINE_ID, card.card_id),
    before,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(`SELECT * FROM pipeline_card_transitions WHERE card_id = ? ORDER BY card_version`)
      .all(card.card_id),
    beforeTransitions,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(`SELECT * FROM pipeline_stage_automation_outbox WHERE card_id = ? ORDER BY created_at`)
      .all(card.card_id),
    beforeOutbox,
  );

  // Undo uses the same CAS primitive with the archived origin as its destination. It is refused at
  // the same boundary, so an API race cannot restore a card into an invisible stage.
  await assert.rejects(
    commitCardTransition(
      harness.env,
      {
        tenantId: TENANT,
        pipelineId: SALES_PIPELINE_ID,
        card,
        toStageId: stageId("visit_booked"),
        expectedVersion: card.version,
        safeguard: "undo",
        reasonCode: null,
        correlationId: "pct_original",
        actorType: "worker",
        actorId: "appu_sales_0001",
        idempotencyKey: "store-inactive-undo-001",
        rawConfirmation: null,
        undoTransitionId: "pct_original",
      },
      new Date(SEED_TIME),
    ),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_stage_changed",
  );
  assert.deepEqual(
    await getCard(harness.env, TENANT, SALES_PIPELINE_ID, card.card_id),
    before,
  );
  harness.db.close();
});

test("card relation resolution exposes only the reviewed board-safe projection", async () => {
  const harness = setup();
  const placed = await placeCard(harness.env, {
    tenantId: TENANT,
    pipelineId: SALES_PIPELINE_ID,
    stageId: stageId("new_lead"),
    entityType: "lead",
    entityId: "lead:board:0001",
    actorType: "worker",
    actorId: "appu_sales_0001",
    idempotencyKey: "store-projection-0001",
  });
  const hex = (seed: string) => seed.repeat(64).slice(0, 64);
  harness.db.raw
    .prepare(
      `INSERT INTO commercial_authority_permits
         (permit_id, tenant_id, policy_id, policy_version, policy_digest, policy_snapshot_json,
          action, actor_type, actor_id, aggregate_type, aggregate_id, aggregate_version,
          amount_cents, command_fingerprint, facts_digest, evidence_refs_json, evidence_digest,
          idempotency_key_hash, request_fingerprint, issued_at, expires_at)
       VALUES ('permit:board:projection:0000000000000001', ?, 'commercial.quote', 'v1', ?, '{}',
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
       VALUES ('quote-revision:board:projection:0001', ?, 'customer-quote:board:0001', 1,
               'job:board:0001', 'customer:board:0001', NULL, 'approved', 'CAD', '2026-12-31',
               900000, 45000, 945000, '{}', ?, '[]', ?, NULL,
               'permit:board:projection:0000000000000001', ?, ?, ?, ?)`,
    )
    .run(TENANT, hex("1"), hex("2"), hex("d"), hex("b"), hex("5"), SEED_TIME);
  const relations = await resolveCardRelations(
    harness.env,
    TENANT,
    [placed.card],
    ["entity", "job", "estimate", "quote"],
  );
  const bag = relations.get(placed.card.card_id);
  assert.ok(bag);
  assert.deepEqual(Object.keys(bag.entity ?? {}).sort(), [
    "contact_email",
    "contact_name",
    "lead_id",
    "lifecycle_status",
  ]);
  assert.equal((bag.entity as Record<string, unknown>).contact_name, "Naina Tamang");
  assert.deepEqual(Object.keys(bag.job ?? {}).sort(), [
    "job_number",
    "job_status",
    "lead_id",
    "service_type",
  ]);
  assert.deepEqual(Object.keys(bag.estimate ?? {}).sort(), [
    "estimate_total_cents",
    "lead_id",
    "status",
  ]);
  assert.deepEqual(Object.keys(bag.quote ?? {}).sort(), [
    "lead_id",
    "revision_number",
    "status",
    "total_cents",
  ]);
  for (const relation of [bag.entity, bag.job, bag.estimate, bag.quote]) {
    assert.ok(!Object.hasOwn(relation ?? {}, "payload_json"));
    assert.ok(!Object.hasOwn(relation ?? {}, "source_envelope_id"));
    assert.ok(!Object.hasOwn(relation ?? {}, "raw_key"));
  }
  harness.db.close();
});
