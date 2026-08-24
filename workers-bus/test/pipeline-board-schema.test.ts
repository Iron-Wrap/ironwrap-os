// pipeline-board-schema.test.ts - the 0113 trigger contract and the generic-core rule (IRO-209).
//
// These cases defend the two things a later migration or a hurried feature is most likely to break:
// the guards that make a transition trail trustworthy, and the promise that no vertical's vocabulary
// leaked into the core model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parsePipelineCardTemplate,
  PipelineTemplateError,
  renderCardSummary,
  templateRelations,
} from "../src/pipeline-board.ts";
import { knownEntityType } from "../src/pipeline-board-store.ts";
import {
  SALES_PIPELINE_ID,
  SALES_TEMPLATE,
  SEED_TIME,
  setup,
  stageId,
  TENANT,
} from "./pipeline-board-fixture.ts";

const MIGRATION = readFileSync(
  new URL("../migrations/0113_pipeline_board_core.sql", import.meta.url),
  "utf8",
);
const DOMAIN_SOURCE = readFileSync(new URL("../src/pipeline-board.ts", import.meta.url), "utf8");
const API_SOURCE = readFileSync(new URL("../src/pipeline-board-api.ts", import.meta.url), "utf8");

/* ------------------------------------------------------------------------ migration ---- */

test("0113 is additive: it creates the pipeline core and alters nothing already shipped", () => {
  for (const table of [
    "pipelines",
    "pipeline_stages",
    "pipeline_cards",
    "pipeline_card_transitions",
    "pipeline_stage_automation_outbox",
  ])
    assert.match(MIGRATION, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  assert.doesNotMatch(MIGRATION, /\bALTER TABLE\b/i);
  assert.doesNotMatch(MIGRATION, /\bDROP TABLE\b/i);
  assert.doesNotMatch(MIGRATION, /\bDROP TRIGGER\b/i);
});

test("the version, identity and append-only guards all exist", () => {
  for (const trigger of [
    "pipelines_version_guard",
    "pipeline_stages_version_guard",
    "pipeline_cards_version_guard",
    "pipelines_identity_guard",
    "pipeline_stages_identity_guard",
    "pipeline_cards_identity_guard",
    "pipeline_card_transitions_append_only_update",
    "pipeline_card_transitions_append_only_delete",
    "pipeline_stage_automation_outbox_append_only_update",
    "pipeline_stage_automation_outbox_append_only_delete",
  ])
    assert.match(MIGRATION, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
});

test("pipeline-board references reject cross-tenant and cross-pipeline coordinates", () => {
  const harness = setup();
  const otherPipeline = "pl_other_0001";
  const otherStage = "pls_other_0001";
  harness.db.raw
    .prepare(
      `INSERT INTO pipelines (
         pipeline_id, tenant_id, key, name, entity_type, card_template_json,
         position, version, created_at, updated_at
       ) VALUES (?, ?, 'other', 'Other', 'lead', '{}', 0, 1, ?, ?)`,
    )
    .run(otherPipeline, "other", SEED_TIME, SEED_TIME);
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_stages (
         stage_id, tenant_id, pipeline_id, key, name, position, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'other_stage', 'Other stage', 0, 1, ?, ?)`,
    )
    .run(otherStage, "other", otherPipeline, SEED_TIME, SEED_TIME);
  const localPipeline = "pl_local_0001";
  const localStage = "pls_local_0001";
  harness.db.raw
    .prepare(
      `INSERT INTO pipelines (
         pipeline_id, tenant_id, key, name, entity_type, card_template_json,
         position, version, created_at, updated_at
       ) VALUES (?, ?, 'local', 'Local', 'lead', '{}', 1, 1, ?, ?)`,
    )
    .run(localPipeline, TENANT, SEED_TIME, SEED_TIME);
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_stages (
         stage_id, tenant_id, pipeline_id, key, name, position, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'local_stage', 'Local stage', 0, 1, ?, ?)`,
    )
    .run(localStage, TENANT, localPipeline, SEED_TIME, SEED_TIME);

  assert.throws(
    () =>
      harness.db.raw
        .prepare(
          `INSERT INTO pipeline_cards (
             card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
             position_in_stage, stage_entered_at, version, created_at, updated_at
           ) VALUES ('plc_cross_pipeline_01', ?, ?, ?, 'lead', 'lead:board:0001', 10, ?, 1, ?, ?)`,
        )
        .run(TENANT, SALES_PIPELINE_ID, otherStage, SEED_TIME, SEED_TIME, SEED_TIME),
    /FOREIGN KEY/,
  );

  assert.throws(
    () =>
      harness.db.raw
        .prepare(
          `INSERT INTO pipelines (
             pipeline_id, tenant_id, key, name, entity_type, card_template_json,
             template_source_id, position, version, created_at, updated_at
           ) VALUES ('pl_cross_tenant_01', 'other', 'cross_tenant', 'Cross tenant', 'lead', '{}', ?, 1, 1, ?, ?)`,
        )
        .run(SALES_PIPELINE_ID, SEED_TIME, SEED_TIME),
    /FOREIGN KEY/,
  );

  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_cards (
         card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
         position_in_stage, stage_entered_at, version, created_at, updated_at
       ) VALUES ('plc_valid_0001', ?, ?, ?, 'lead', 'lead:board:0001', 10, ?, 1, ?, ?)`,
    )
    .run(TENANT, SALES_PIPELINE_ID, stageId("new_lead"), SEED_TIME, SEED_TIME, SEED_TIME);
  assert.throws(
    () =>
      harness.db.raw
        .prepare(
          `INSERT INTO pipeline_card_transitions (
             transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
             actor_type, actor_id, safeguard, command_fingerprint, idempotency_key_hash,
             card_version, occurred_at, created_at
           ) VALUES ('pct_cross_pipeline_01', ?, ?, 'plc_valid_0001', NULL, ?,
             'owner', 'appu_owner_0001', 'direct', ?, ?, 1, ?, ?)`,
        )
        .run(
          TENANT,
          localPipeline,
          localStage,
          "a".repeat(64),
          "b".repeat(64),
          SEED_TIME,
          SEED_TIME,
        ),
    /FOREIGN KEY/,
  );
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_card_transitions (
         transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
         actor_type, actor_id, safeguard, command_fingerprint, idempotency_key_hash,
         card_version, occurred_at, created_at
       ) VALUES ('pct_valid_0001', ?, ?, 'plc_valid_0001', NULL, ?,
         'owner', 'appu_owner_0001', 'direct', ?, ?, 1, ?, ?)`,
    )
    .run(
      TENANT,
      SALES_PIPELINE_ID,
      stageId("new_lead"),
      "c".repeat(64),
      "d".repeat(64),
      SEED_TIME,
      SEED_TIME,
    );
  assert.throws(
    () =>
      harness.db.raw
        .prepare(
          `INSERT INTO pipeline_stage_automation_outbox (
             outbox_id, tenant_id, pipeline_id, card_id, transition_id,
             from_stage_id, to_stage_id, status, created_at
           ) VALUES ('pcto_cross_pipeline_01', ?, ?, 'plc_valid_0001', 'pct_valid_0001',
             NULL, ?, 'pending', ?)`,
        )
        .run(TENANT, localPipeline, localStage, SEED_TIME),
    /FOREIGN KEY/,
  );

  harness.db.close();
});

/* ------------------------------------------------------------------- trigger contract ---- */

test("a card update that does not advance the version by exactly one is refused", () => {
  const harness = setup();
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_cards
         (card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
          position_in_stage, stage_entered_at, version, created_at, updated_at)
       VALUES ('plc_guard_0001', ?, ?, ?, 'lead', 'lead:board:0001', 10, ?, 1, ?, ?)`,
    )
    .run(TENANT, SALES_PIPELINE_ID, stageId("new_lead"), SEED_TIME, SEED_TIME, SEED_TIME);

  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_cards SET stage_id = ?, version = 1 WHERE card_id = ?`)
        .run(stageId("visit_booked"), "plc_guard_0001"),
    /pipeline_cards_version_conflict/,
  );
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_cards SET stage_id = ?, version = 7 WHERE card_id = ?`)
        .run(stageId("visit_booked"), "plc_guard_0001"),
    /pipeline_cards_version_conflict/,
  );
  harness.db.raw
    .prepare(`UPDATE pipeline_cards SET stage_id = ?, version = 2 WHERE card_id = ?`)
    .run(stageId("visit_booked"), "plc_guard_0001");
  harness.db.close();
});

test("a card's identity - its pipeline and the entity it binds to - cannot be rewritten", () => {
  const harness = setup();
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_cards
         (card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
          position_in_stage, stage_entered_at, version, created_at, updated_at)
       VALUES ('plc_guard_0002', ?, ?, ?, 'lead', 'lead:board:0001', 10, ?, 1, ?, ?)`,
    )
    .run(TENANT, SALES_PIPELINE_ID, stageId("new_lead"), SEED_TIME, SEED_TIME, SEED_TIME);
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_cards SET entity_id = ?, version = 2 WHERE card_id = ?`)
        .run("lead:board:0002", "plc_guard_0002"),
    /pipeline_cards_identity_immutable/,
  );
  harness.db.close();
});

test("a stage key is immutable so a renamed label never breaks a rule keyed on it", () => {
  const harness = setup();
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_stages SET key = 'renamed', version = 2 WHERE stage_id = ?`)
        .run(stageId("need_quote")),
    /pipeline_stages_identity_immutable/,
  );
  // The visible name is freely editable, which is the whole point of separating the two.
  harness.db.raw
    .prepare(
      `UPDATE pipeline_stages SET name = 'Awaiting Quote', version = 2, updated_at = ?
        WHERE stage_id = ?`,
    )
    .run("2026-08-22T12:30:00.000Z", stageId("need_quote"));
  harness.db.close();
});

test("the transition trail and the automation outbox refuse UPDATE and DELETE", () => {
  const harness = setup();
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_cards
         (card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
          position_in_stage, stage_entered_at, version, created_at, updated_at)
       VALUES ('plc_guard_0003', ?, ?, ?, 'lead', 'lead:board:0001', 10, ?, 1, ?, ?)`,
    )
    .run(TENANT, SALES_PIPELINE_ID, stageId("new_lead"), SEED_TIME, SEED_TIME, SEED_TIME);
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_card_transitions
         (transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
          actor_type, actor_id, safeguard, reason_code, correlation_id,
          command_fingerprint, idempotency_key_hash, card_version, occurred_at, created_at)
       VALUES ('pct_guard_0001', ?, ?, 'plc_guard_0003', ?, ?, 'owner', 'appu_owner_0001',
               'direct', NULL, NULL, ?, ?, 2, ?, ?)`,
    )
    .run(
      TENANT,
      SALES_PIPELINE_ID,
      stageId("new_lead"),
      stageId("visit_booked"),
      "a".repeat(64),
      "b".repeat(64),
      SEED_TIME,
      SEED_TIME,
    );
  harness.db.raw
    .prepare(
      `INSERT INTO pipeline_stage_automation_outbox
         (outbox_id, tenant_id, pipeline_id, card_id, transition_id, from_stage_id, to_stage_id,
          status, created_at)
       VALUES ('pcto_guard_0001', ?, ?, 'plc_guard_0003', 'pct_guard_0001', ?, ?, 'pending', ?)`,
    )
    .run(TENANT, SALES_PIPELINE_ID, stageId("new_lead"), stageId("visit_booked"), SEED_TIME);

  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_card_transitions SET safeguard = 'confirmed' WHERE transition_id = ?`)
        .run("pct_guard_0001"),
    /pipeline_card_transitions_append_only/,
  );
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`DELETE FROM pipeline_card_transitions WHERE transition_id = ?`)
        .run("pct_guard_0001"),
    /pipeline_card_transitions_append_only/,
  );
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`DELETE FROM pipeline_stage_automation_outbox WHERE outbox_id = ?`)
        .run("pcto_guard_0001"),
    /pipeline_stage_automation_outbox_append_only/,
  );
  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_stage_automation_outbox SET to_stage_id = ? WHERE outbox_id = ?`)
        .run(stageId("deposit"), "pcto_guard_0001"),
    /pipeline_stage_automation_outbox_append_only/,
  );
  // An M4 consumer must still be able to claim its own work.
  harness.db.raw
    .prepare(`UPDATE pipeline_stage_automation_outbox SET status = 'claimed' WHERE outbox_id = ?`)
    .run("pcto_guard_0001");
  harness.db.close();
});

/* ------------------------------------------------------------------- generic-core rule ---- */

const VERTICAL_NOUNS = /\b(roof|roofing|shingle|gutter|siding|eaves|soffit|fascia)\w*/i;

/** Prose may discuss the vertical; identifiers may not carry it. Only the code is under test. */
const codeOnly = (source: string) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/\/\/.*$/gm, " ");

test("no vertical noun appears in the core schema, the domain module, or a route path", () => {
  assert.doesNotMatch(MIGRATION, VERTICAL_NOUNS);
  assert.doesNotMatch(codeOnly(DOMAIN_SOURCE), VERTICAL_NOUNS);
  for (const route of API_SOURCE.matchAll(/\/api\/v1\/[A-Za-z0-9/_:$^\\[\]()+*.-]*/g))
    assert.doesNotMatch(route[0], VERTICAL_NOUNS);
});

test("the entity-type registry speaks the generic vocabulary, not a vertical's", () => {
  assert.ok(knownEntityType("lead"));
  assert.ok(knownEntityType("job"));
  assert.equal(knownEntityType("roof_job"), false);
  assert.equal(knownEntityType("unicorn"), false);
});

/* ---------------------------------------------------------------- the shipped template ---- */

test("the shipped Sales template is valid under the Worker's own card-template parser", () => {
  const template = parsePipelineCardTemplate(SALES_TEMPLATE.card_template);
  assert.deepEqual(
    template.slots.map((slot) => slot.slot),
    ["title", "amount", "identifier", "tag", "won_flag"],
  );
  assert.deepEqual(templateRelations(template), ["entity", "estimate", "job", "quote", "stage"]);
  // PO decision D5: services is a single-element list read from the job's one service field; no
  // multi-select exists anywhere in the system yet, and M1 does not invent one.
  const tag = template.slots.find((slot) => slot.slot === "tag");
  assert.deepEqual(tag?.sources, ["job.service_type"]);
  // PO decision D6: the job number is the only identifier bound; no opaque id is dressed up as a
  // human lead code.
  const identifiers = template.slots.filter((slot) => slot.slot === "identifier");
  assert.deepEqual(
    identifiers.map((slot) => [slot.label, slot.sources]),
    [["Job", ["job.job_number"]]],
  );
});

test("the shipped Sales stages are the stakeholder's seven, with 'Contract signed' as the won one", () => {
  assert.deepEqual(
    SALES_TEMPLATE.stages.map((stage: { name: string }) => stage.name),
    [
      "New Lead",
      "Visit Booked",
      "Need Quote",
      "Quote Sent",
      "Contract signed",
      "Deposit",
      "Materials in prod",
    ],
  );
  const won = SALES_TEMPLATE.stages.filter((stage: { is_won: number }) => stage.is_won === 1);
  assert.deepEqual(
    won.map((stage: { key: string }) => stage.key),
    ["contract_signed"],
  );
  // PO decision D3: no lost stage in the M1 seed; the schema flag stays available for M3.
  assert.equal(
    SALES_TEMPLATE.stages.filter((stage: { is_lost: number }) => stage.is_lost === 1).length,
    0,
  );
});

/* ------------------------------------------------------------------- template grammar ---- */

test("a template without a title slot, or with an unparseable source, is refused", () => {
  assert.throws(
    () => parsePipelineCardTemplate({ version: 1, slots: [{ slot: "tag", source: "job.x" }] }),
    (error: unknown) =>
      error instanceof PipelineTemplateError &&
      error.code === "pipeline_card_template_title_required",
  );
  assert.throws(
    () => parsePipelineCardTemplate({ version: 1, slots: [{ slot: "title", source: "nodot" }] }),
    (error: unknown) =>
      error instanceof PipelineTemplateError &&
      error.code === "pipeline_card_template_source_invalid",
  );
  assert.throws(
    () =>
      parsePipelineCardTemplate({
        version: 1,
        slots: [{ slot: "title", source: "entity.name" }, { slot: "identifier", source: "job.n" }],
      }),
    (error: unknown) =>
      error instanceof PipelineTemplateError &&
      error.code === "pipeline_card_template_identifier_label_required",
  );
  assert.throws(
    () => parsePipelineCardTemplate({ version: 2, slots: [] }),
    (error: unknown) =>
      error instanceof PipelineTemplateError &&
      error.code === "pipeline_card_template_version_unsupported",
  );
});

test("a slot whose sources are all empty contributes nothing rather than a blank line", () => {
  const template = parsePipelineCardTemplate(SALES_TEMPLATE.card_template);
  const summary = renderCardSummary(
    template,
    { entity: { contact_name: "  " }, job: null, estimate: null, quote: null, stage: null },
    "lead:fallback",
  );
  assert.equal(summary.title, "lead:fallback");
  assert.equal(Object.hasOwn(summary, "amount_cents"), false);
  assert.deepEqual(summary.identifiers, []);
  assert.deepEqual(summary.tags, []);
  assert.deepEqual(summary.counters, []);
  assert.equal(summary.is_won, false);
});
