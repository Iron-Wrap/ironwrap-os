import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commitCardTransition,
  getCard,
  placeCard,
  PipelineStoreError,
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
