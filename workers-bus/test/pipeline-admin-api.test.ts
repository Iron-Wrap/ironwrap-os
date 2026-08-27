// pipeline-admin-api.test.ts - configurable multi-pipeline administration (IRO-209, ELEC-175).
//
// Every case here drives the real `/api/v1/admin/pipelines` route handler against a real database
// with every migration applied. Nothing asserts what an administration screen would render: the
// stakeholder's requirement is that an administrator reshapes boards WITHOUT a developer, so what
// is proved is what the SERVER accepted, refused, and wrote - authority, tenant isolation, the
// version CAS, the fail-closed role scope, and the exact blocker behind a destructive edit.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { handlePipelineRoute } from "../src/pipeline-board-api.ts";
import { PipelineStoreError, removeStage } from "../src/pipeline-board-store.ts";
import {
  auth,
  OTHER_TENANT,
  request,
  SALES_PIPELINE_ID,
  setup,
  stageId,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const ADMIN = "/api/v1/admin/pipelines";
const NOW = new Date("2026-08-26T10:00:00.000Z");

const CARD_TEMPLATE = {
  version: 1,
  slots: [{ slot: "title", sources: ["entity.contact_name", "entity.contact_email"] }],
};

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: { body?: unknown; who?: Parameters<typeof auth>[0]; tenant?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request(method, path, { body: options.body, idempotency: null }),
    harness.env,
    auth(options.who ?? "owner", options.tenant ?? TENANT),
    NOW,
  );
  assert.ok(response, `route did not claim ${method} ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** A minimal, entirely generic board an administrator could create from the admin surface. */
function newPipelineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "shop_production",
    name: "Shop production",
    entity_type: "job",
    owning_role: "production",
    card_template: CARD_TEMPLATE,
    stages: [
      { key: "queued", name: "Queued", color: "slate" },
      { key: "cutting", name: "Cutting", color: "sky" },
      { key: "ready", name: "Ready", color: "emerald", is_won: true },
    ],
    ...overrides,
  };
}

async function created(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = await call(harness, "POST", ADMIN, { body: newPipelineBody(overrides) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.pipeline as Record<string, any>;
}

async function seededSales(harness: Harness): Promise<Record<string, any>> {
  const listed = await call(harness, "GET", ADMIN);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const pipeline = (listed.body.pipelines as Record<string, any>[]).find(
    (candidate) => candidate.pipeline_id === SALES_PIPELINE_ID,
  );
  assert.ok(pipeline, "seeded Sales board missing from the administration list");
  return pipeline;
}

async function placeCard(
  harness: Harness,
  pipelineId: string,
  stageKey: string,
  leadId = "lead:board:0001",
  key = "admin-place-0000000001",
): Promise<{ cardId: string; version: number }> {
  const response = await handlePipelineRoute(
    request("POST", `/api/v1/pipelines/${pipelineId}/cards`, {
      body: { entity_type: "lead", entity_id: leadId, stage_key: stageKey },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    NOW,
  );
  assert.ok(response);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 201, JSON.stringify(body));
  return { cardId: String(body.card_id), version: Number(body.card_version) };
}

async function boardCall(
  harness: Harness,
  method: string,
  path: string,
  options: { body?: unknown; who?: Parameters<typeof auth>[0]; idempotency?: string | null } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request(method, path, {
      body: options.body,
      idempotency: options.idempotency ?? (method === "GET" ? null : "board-key-0000000001"),
    }),
    harness.env,
    auth(options.who ?? "owner"),
    NOW,
  );
  assert.ok(response, `route did not claim ${method} ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/* ------------------------------------------------------------------- authority ------ */

test("only the administrator role reaches the administration surface at all", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const routes: Array<[string, string, unknown]> = [
    ["GET", ADMIN, undefined],
    ["POST", ADMIN, newPipelineBody()],
    ["POST", `${ADMIN}/${SALES_PIPELINE_ID}`, { expected_version: sales.version, name: "Renamed" }],
    ["POST", `${ADMIN}/${SALES_PIPELINE_ID}/copy`, { key: "copy_one", name: "Copy" }],
    [
      "POST",
      `${ADMIN}/${SALES_PIPELINE_ID}/stages`,
      { expected_version: sales.version, key: "extra", name: "Extra" },
    ],
    ["POST", `${ADMIN}/${SALES_PIPELINE_ID}/roles`, { expected_version: sales.version, grants: [] }],
  ];
  for (const who of ["sales", "ops", "production", "field"] as const)
    for (const [method, path, body] of routes) {
      const response = await call(harness, method, path, { who, body });
      assert.equal(response.status, 403, `${who} ${method} ${path}`);
      assert.equal(response.body.error, "pipeline_admin_forbidden");
    }
  // Nothing leaked while refusing: the tenant still holds exactly the seeded board.
  const listed = await call(harness, "GET", ADMIN);
  assert.equal(listed.body.pipelines.length, 1);
  harness.db.close();
});

test("an administration write without the CSRF header is refused before anything is read", async () => {
  const harness = setup();
  const response = await handlePipelineRoute(
    request("POST", ADMIN, { body: newPipelineBody(), idempotency: null, csrf: false }),
    harness.env,
    auth("owner"),
    NOW,
  );
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as Record<string, unknown>).error, "csrf_failed");
  harness.db.close();
});

/* ------------------------------------------- an unrestricted number of pipelines ------ */

test("a tenant may hold an unrestricted number of pipelines; no fixed cap survives anywhere", async () => {
  const harness = setup();
  const wanted = 105; // deliberately past the 100-row ceiling the list read used to carry
  for (let index = 0; index < wanted; index += 1)
    await created(harness, {
      key: `board_${index}`,
      name: `Board ${index}`,
      position: index + 1,
      owning_role: null,
    });

  const listed = await call(harness, "GET", ADMIN);
  assert.equal(listed.body.pipelines.length, wanted + 1);

  // The board switcher an owner actually reads sees every one of them too, not the first hundred.
  const board = await boardCall(harness, "GET", "/api/v1/pipelines");
  assert.equal(board.body.pipelines.length, wanted + 1);

  const store = readFileSync(new URL("../src/pipeline-board-store.ts", import.meta.url), "utf8");
  const listQuery = store.slice(
    store.indexOf("export async function listPipelines("),
    store.indexOf("/** Every pipeline an administrator may configure"),
  );
  assert.doesNotMatch(listQuery, /\bLIMIT\b/i);
  const migration = readFileSync(
    new URL("../migrations/0122_pipeline_admin_configuration.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(migration, /pipeline_count|max_pipelines/i);
  harness.db.close();
});

test("a created board is a working board: it takes cards through the ordinary route", async () => {
  const harness = setup();
  const pipeline = await created(harness, {
    key: "resale",
    name: "Material resale",
    entity_type: "lead",
    owning_role: "sales",
    stages: [
      { key: "enquiry", name: "Enquiry" },
      { key: "quoted", name: "Quoted" },
    ],
  });
  const card = await placeCard(harness, pipeline.pipeline_id, "enquiry");
  const board = await boardCall(
    harness,
    "GET",
    `/api/v1/pipelines/${pipeline.pipeline_id}/board`,
    { who: "sales" },
  );
  assert.equal(board.status, 200);
  assert.equal(board.body.cards.length, 1);
  assert.equal(board.body.cards[0].card_id, card.cardId);
  assert.deepEqual(
    board.body.stages.map((stage: Record<string, unknown>) => stage.key),
    ["enquiry", "quoted"],
  );
  harness.db.close();
});

/* ------------------------------------------------------------------------ copy ------ */

test("copying a board produces an independent pipeline whose edits never touch the source", async () => {
  const harness = setup();
  const source = await seededSales(harness);
  const copy = (
    await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/copy`, {
      body: { key: "sales_second_office", name: "Sales - second office" },
    })
  ).body.pipeline as Record<string, any>;

  assert.notEqual(copy.pipeline_id, source.pipeline_id);
  assert.equal(copy.template_source_id, source.pipeline_id);
  assert.equal(copy.entity_type, source.entity_type);
  assert.deepEqual(
    copy.stages.map((stage: Record<string, unknown>) => [stage.key, stage.name, stage.color, stage.is_won]),
    source.stages.map((stage: Record<string, unknown>) => [stage.key, stage.name, stage.color, stage.is_won]),
  );

  // Cards never travel: a second office opens empty, not holding the first office's customers.
  await placeCard(harness, SALES_PIPELINE_ID, "new_lead");
  const afterCard = await call(harness, "GET", ADMIN);
  const copiedAfter = (afterCard.body.pipelines as Record<string, any>[]).find(
    (candidate) => candidate.pipeline_id === copy.pipeline_id,
  ) as Record<string, any>;
  assert.equal(copiedAfter.card_count, 0);

  // Editing the copy is invisible to the source: there is no live link, only a provenance column.
  const renamed = await call(
    harness,
    "POST",
    `${ADMIN}/${copy.pipeline_id}/stages/${copy.stages[0].stage_id}`,
    { body: { expected_version: copiedAfter.version, name: "Fresh enquiry", color: "info" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const archived = await call(harness, "POST", `${ADMIN}/${copy.pipeline_id}`, {
    body: { expected_version: renamed.body.pipeline.version, is_active: false },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const sourceAfter = await seededSales(harness);
  assert.equal(sourceAfter.is_active, true);
  assert.equal(sourceAfter.stages[0].name, source.stages[0].name);
  assert.equal(sourceAfter.version, source.version);
  harness.db.close();
});

test("a copy cannot reuse a key that already names a board in the tenant", async () => {
  const harness = setup();
  const response = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/copy`, {
    body: { key: "sales", name: "Sales again" },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "pipeline_key_exists");
  harness.db.close();
});

/* ---------------------------------------------------------------- stage lifecycle ------ */

test("removing a stage that still holds cards is refused with the exact count", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  await placeCard(harness, SALES_PIPELINE_ID, "need_quote");

  const refused = await call(
    harness,
    "POST",
    `${ADMIN}/${SALES_PIPELINE_ID}/stages/${stageId("need_quote")}/remove`,
    { body: { expected_version: sales.version } },
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "pipeline_stage_has_cards");
  assert.equal(refused.body.card_count, 1);
  assert.equal(refused.body.stage_id, stageId("need_quote"));
  assert.ok(!refused.body.available_stage_ids.includes(stageId("need_quote")));

  // Refused means nothing moved: the stage, the card and the pipeline version are all untouched.
  const after = await seededSales(harness);
  assert.equal(after.version, sales.version);
  assert.equal(
    (after.stages as Record<string, any>[]).find((stage) => stage.key === "need_quote")?.card_count,
    1,
  );
  harness.db.close();
});

test("naming a destination re-homes the cards and removes the stage in one call", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const card = await placeCard(harness, SALES_PIPELINE_ID, "need_quote");

  const removed = await call(
    harness,
    "POST",
    `${ADMIN}/${SALES_PIPELINE_ID}/stages/${stageId("need_quote")}/remove`,
    {
      body: {
        expected_version: sales.version,
        move_cards_to_stage_id: stageId("quote_sent"),
      },
    },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.moved_cards, 1);
  // The trail already names this stage, so removal archives rather than destroying evidence.
  assert.equal(removed.body.outcome, "archived");
  assert.ok(
    !(removed.body.stages as Record<string, any>[]).some((stage) => stage.key === "need_quote"),
  );

  const moved = harness.db.raw
    .prepare(`SELECT stage_id FROM pipeline_cards WHERE card_id = ?`)
    .get(card.cardId) as { stage_id: string };
  assert.equal(moved.stage_id, stageId("quote_sent"));

  // The re-home is audited like any other move, and deliberately does NOT wake the automation
  // outbox: reshaping a board is configuration, not work moving through the business.
  const trail = harness.db.raw
    .prepare(
      `SELECT from_stage_id, to_stage_id, reason_code, safeguard FROM pipeline_card_transitions
        WHERE card_id = ? ORDER BY card_version ASC`,
    )
    .all(card.cardId) as Record<string, unknown>[];
  assert.equal(trail.length, 2);
  assert.deepEqual(
    [trail[1]?.from_stage_id, trail[1]?.to_stage_id, trail[1]?.reason_code, trail[1]?.safeguard],
    [stageId("need_quote"), stageId("quote_sent"), "stage_removed", "confirmed"],
  );
  const outbox = harness.db.raw
    .prepare(`SELECT COUNT(*) AS total FROM pipeline_stage_automation_outbox`)
    .get() as { total: number };
  assert.equal(Number(outbox.total), 1);

  // An archived stage leaves the board entirely, so it can never sit invisibly between two live
  // columns and turn a one-step move into a skip.
  const board = await boardCall(harness, "GET", `/api/v1/pipelines/${SALES_PIPELINE_ID}/board`);
  assert.ok(!(board.body.stages as Record<string, any>[]).some((stage) => stage.key === "need_quote"));
  harness.db.close();
});

test("a stage that gained a card mid-command is not removed out from under it", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  await placeCard(harness, SALES_PIPELINE_ID, "need_quote");

  const beforePipeline = harness.db.raw
    .prepare(
      `SELECT pipeline_id, version, configuration_marker, position, updated_at
         FROM pipelines WHERE tenant_id = ? AND pipeline_id = ?`,
    )
    .get(TENANT, SALES_PIPELINE_ID);
  const beforeStage = harness.db.raw
    .prepare(
      `SELECT stage_id, is_active, version, updated_at
         FROM pipeline_stages WHERE tenant_id = ? AND stage_id = ?`,
    )
    .get(TENANT, stageId("need_quote"));
  const beforeCard = harness.db.raw
    .prepare(
      `SELECT card_id, stage_id, version, last_transition_id, updated_at
         FROM pipeline_cards WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?`,
    )
    .all(TENANT, SALES_PIPELINE_ID, stageId("need_quote"));
  const beforeEvents = harness.db.raw
    .prepare(
      `SELECT * FROM pipeline_configuration_events
         WHERE tenant_id = ? AND pipeline_id = ? ORDER BY pipeline_version ASC, event_id ASC`,
    )
    .all(TENANT, SALES_PIPELINE_ID);

  // Exactly the race the route's pre-read cannot close: the command was accepted believing the
  // stage was empty, and a card arrived before the batch committed.
  await assert.rejects(
    removeStage(
      harness.env,
      {
        tenantId: TENANT,
        pipelineId: SALES_PIPELINE_ID,
        stageId: stageId("need_quote"),
        expectedVersion: sales.version,
        moveCardsToStageId: null,
        cardCount: 0,
        archiveOnly: true,
        actor: { role: "owner", userId: "appu_owner_0001" },
      },
      NOW,
    ),
    (error: unknown) =>
      error instanceof PipelineStoreError && error.code === "pipeline_stage_changed",
  );

  // The failed batch is all-or-nothing: pipeline CAS, stage mutation, card state and evidence are
  // byte-for-byte unchanged, not merely "still live" by a convenient postcondition.
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT pipeline_id, version, configuration_marker, position, updated_at
           FROM pipelines WHERE tenant_id = ? AND pipeline_id = ?`,
      )
      .get(TENANT, SALES_PIPELINE_ID),
    beforePipeline,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT stage_id, is_active, version, updated_at
           FROM pipeline_stages WHERE tenant_id = ? AND stage_id = ?`,
      )
      .get(TENANT, stageId("need_quote")),
    beforeStage,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT card_id, stage_id, version, last_transition_id, updated_at
           FROM pipeline_cards WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?`,
      )
      .all(TENANT, SALES_PIPELINE_ID, stageId("need_quote")),
    beforeCard,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT * FROM pipeline_configuration_events
           WHERE tenant_id = ? AND pipeline_id = ? ORDER BY pipeline_version ASC, event_id ASC`,
      )
      .all(TENANT, SALES_PIPELINE_ID),
    beforeEvents,
  );

  // The stage is still live and the trail records no removal that did not happen.
  const stage = harness.db.raw
    .prepare(`SELECT is_active FROM pipeline_stages WHERE stage_id = ?`)
    .get(stageId("need_quote")) as { is_active: number };
  assert.equal(Number(stage.is_active), 1);
  const events = harness.db.raw
    .prepare(
      `SELECT COUNT(*) AS total FROM pipeline_configuration_events
        WHERE pipeline_id = ? AND action IN ('stage_archived', 'stage_removed')`,
    )
    .get(SALES_PIPELINE_ID) as { total: number };
  assert.equal(Number(events.total), 0);
  harness.db.close();
});

test("a stage nothing ever touched is deleted outright, leaving no residue", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const added = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages`, {
    body: { expected_version: sales.version, key: "typo", name: "Typo" },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const removed = await call(
    harness,
    "POST",
    `${ADMIN}/${SALES_PIPELINE_ID}/stages/${added.body.stage.stage_id}/remove`,
    { body: { expected_version: added.body.pipeline.version } },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.outcome, "deleted");
  const rows = harness.db.raw
    .prepare(`SELECT COUNT(*) AS total FROM pipeline_stages WHERE stage_id = ?`)
    .get(added.body.stage.stage_id) as { total: number };
  assert.equal(Number(rows.total), 0);
  harness.db.close();
});

test("the last remaining stage of a board can never be removed", async () => {
  const harness = setup();
  const pipeline = await created(harness, {
    key: "single",
    name: "Single",
    stages: [{ key: "only", name: "Only" }],
  });
  const response = await call(
    harness,
    "POST",
    `${ADMIN}/${pipeline.pipeline_id}/stages/${pipeline.stages[0].stage_id}/remove`,
    { body: { expected_version: pipeline.version } },
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "pipeline_stage_last_remaining");
  harness.db.close();
});

test("stages are added, renamed, recoloured and reordered, and the order redefines adjacency", async () => {
  const harness = setup();
  let sales = await seededSales(harness);

  const added = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages`, {
    body: {
      expected_version: sales.version,
      key: "site_visit",
      name: "Site visit",
      color: "amber",
      min_role_to_enter: "ops",
    },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.stage.key, "site_visit");
  assert.equal(added.body.stage.min_role_to_enter, "ops");

  sales = added.body.pipeline;
  const renamed = await call(
    harness,
    "POST",
    `${ADMIN}/${SALES_PIPELINE_ID}/stages/${added.body.stage.stage_id}`,
    { body: { expected_version: sales.version, name: "On-site visit", color: "info", min_role_to_enter: null } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.stage.name, "On-site visit");
  assert.equal(renamed.body.stage.color, "info");
  assert.equal(renamed.body.stage.min_role_to_enter, null);

  // A stage key never changes, so an automation rule or a saved view keyed on it survives a rename.
  assert.equal(renamed.body.stage.key, "site_visit");

  sales = renamed.body.pipeline;
  const order = (sales.stages as Record<string, any>[])
    .filter((stage) => stage.is_active)
    .map((stage) => stage.stage_id as string);
  const reversedTail = [order[0], order[2], order[1], ...order.slice(3)];
  const reordered = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages/order`, {
    body: { expected_version: sales.version, stage_ids: reversedTail },
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(
    (reordered.body.stages as Record<string, any>[]).map((stage) => stage.stage_id),
    reversedTail,
  );

  // Adjacency follows the ordered list, so the move that used to be one step is now a skip and the
  // server demands a confirmation for it - the safeguard reads configuration, not a constant.
  const card = await placeCard(harness, SALES_PIPELINE_ID, "new_lead");
  const jump = await boardCall(
    harness,
    "POST",
    `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards/${card.cardId}/transitions`,
    {
      body: { to_stage_id: order[1], expected_version: card.version },
      idempotency: "reorder-jump-0000001",
    },
  );
  assert.equal(jump.status, 409);
  assert.equal(jump.body.error, "confirmation_required");
  assert.equal(jump.body.jump, "skip");
  harness.db.close();
});

test("a partial stage order is refused rather than silently applied", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const ids = (sales.stages as Record<string, any>[]).map((stage) => stage.stage_id as string);
  const response = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages/order`, {
    body: { expected_version: sales.version, stage_ids: ids.slice(0, 3) },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "pipeline_stage_order_incomplete");
  const after = await seededSales(harness);
  assert.equal(after.version, sales.version);
  harness.db.close();
});

test("impossible or duplicated stage configuration is refused with its own blocker", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const wonAndLost = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages`, {
    body: { expected_version: sales.version, key: "both", name: "Both", is_won: true, is_lost: true },
  });
  assert.equal(wonAndLost.status, 400);
  assert.equal(wonAndLost.body.error, "pipeline_stage_won_and_lost");

  const duplicate = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages`, {
    body: { expected_version: sales.version, key: "new_lead", name: "New Lead again" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "pipeline_stage_key_exists");
  harness.db.close();
});

test("all pipeline role fields fail closed against the published account vocabulary", async () => {
  const harness = setup();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unknown owning role", newPipelineBody({ key: "unknown_owner", owning_role: "auditor" })],
    [
      "unknown stage entry role",
      newPipelineBody({
        key: "unknown_stage_role",
        stages: [
          { key: "queued", name: "Queued", min_role_to_enter: "auditor" },
          { key: "done", name: "Done" },
        ],
      }),
    ],
    [
      "unknown grant role",
      newPipelineBody({
        key: "unknown_grant",
        role_grants: [{ role: "auditor", can_write: true }],
      }),
    ],
  ];
  for (const [label, body] of cases) {
    const response = await call(harness, "POST", ADMIN, { body });
    assert.equal(response.status, 400, label);
    assert.equal(response.body.error, "pipeline_role_unknown", label);
    assert.ok((response.body.roles as string[]).includes("owner"), label);
  }

  const sales = await seededSales(harness);
  const copyRole = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/copy`, {
    body: { key: "unknown_copy_role", name: "Unknown copy", owning_role: "auditor" },
  });
  assert.equal(copyRole.status, 400, JSON.stringify(copyRole.body));
  assert.equal(copyRole.body.error, "pipeline_role_unknown");

  const copyGrant = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/copy`, {
    body: {
      key: "unknown_copy_grant",
      name: "Unknown copy grant",
      copy_role_grants: false,
      role_grants: [{ role: "auditor", can_write: false }],
    },
  });
  assert.equal(copyGrant.status, 400, JSON.stringify(copyGrant.body));
  assert.equal(copyGrant.body.error, "pipeline_role_unknown");

  const update = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: sales.version, owning_role: "auditor" },
  });
  assert.equal(update.status, 400, JSON.stringify(update.body));
  assert.equal(update.body.error, "pipeline_role_unknown");

  const stageUpdate = await call(
    harness,
    "POST",
    `${ADMIN}/${SALES_PIPELINE_ID}/stages/${stageId("new_lead")}`,
    { body: { expected_version: sales.version, min_role_to_enter: "auditor" } },
  );
  assert.equal(stageUpdate.status, 400, JSON.stringify(stageUpdate.body));
  assert.equal(stageUpdate.body.error, "pipeline_role_unknown");

  const pipelines = harness.db.raw
    .prepare(`SELECT key FROM pipelines WHERE tenant_id = ? ORDER BY key ASC`)
    .all(TENANT) as Array<{ key: string }>;
  assert.deepEqual(
    pipelines.map((pipeline) => pipeline.key),
    ["sales"],
    "rejected role values must not create or copy a board",
  );
  harness.db.close();
});

test("a large stage reorder stores bounded valid audit evidence", async () => {
  const harness = setup();
  const manyStages = Array.from({ length: 100 }, (_, index) => ({
    key: `stage_${index}`,
    name: `Stage ${index}`,
  }));
  const pipeline = await created(harness, {
    key: "many_stages",
    name: "Many stages",
    stages: manyStages,
  });
  const reversed = [...(pipeline.stages as Record<string, any>[])]
    .reverse()
    .map((stage) => stage.stage_id as string);
  const reordered = await call(harness, "POST", `${ADMIN}/${pipeline.pipeline_id}/stages/order`, {
    body: { expected_version: pipeline.version, stage_ids: reversed },
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));

  const event = harness.db.raw
    .prepare(
      `SELECT detail_json FROM pipeline_configuration_events
         WHERE pipeline_id = ? AND action = 'stages_reordered'`,
    )
    .get(pipeline.pipeline_id) as { detail_json: string };
  assert.ok(event);
  assert.ok(event.detail_json.length <= 4_000);
  const detail = JSON.parse(event.detail_json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(detail).sort(), ["order_count", "order_sha256"]);
  assert.equal(detail.order_count, 100);
  assert.match(String(detail.order_sha256), /^[a-f0-9]{64}$/);
  harness.db.close();
});

/* --------------------------------------------------------------- role scoping ------ */

test("a role with no owned pipeline reads the empty state on every route, never a widened view", async () => {
  const harness = setup();
  // A second board owned by nobody: production owns neither it nor the seeded Sales board.
  const orphan = await created(harness, {
    key: "unowned",
    name: "Unowned",
    entity_type: "lead",
    owning_role: null,
    stages: [
      { key: "one", name: "One" },
      { key: "two", name: "Two" },
    ],
  });
  const card = await placeCard(harness, SALES_PIPELINE_ID, "new_lead");

  const list = await boardCall(harness, "GET", "/api/v1/pipelines", { who: "production" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.pipelines, []);

  for (const pipelineId of [SALES_PIPELINE_ID, orphan.pipeline_id]) {
    const board = await boardCall(harness, "GET", `/api/v1/pipelines/${pipelineId}/board`, {
      who: "production",
    });
    assert.equal(board.status, 404, `board read ${pipelineId}`);
    const placement = await boardCall(harness, "POST", `/api/v1/pipelines/${pipelineId}/cards`, {
      who: "production",
      body: { entity_type: "lead", entity_id: "lead:board:0002", stage_key: "new_lead" },
      idempotency: "prod-place-000000001",
    });
    assert.equal(placement.status, 404, `card create ${pipelineId}`);
  }
  const move = await boardCall(
    harness,
    "POST",
    `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards/${card.cardId}/transitions`,
    {
      who: "production",
      body: { to_stage_id: stageId("visit_booked"), expected_version: card.version },
      idempotency: "prod-move-0000000001",
    },
  );
  assert.equal(move.status, 404);
  const undo = await boardCall(
    harness,
    "POST",
    `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards/${card.cardId}/transitions/pct_none/undo`,
    { who: "production", body: { expected_version: card.version }, idempotency: "prod-undo-000000001" },
  );
  assert.equal(undo.status, 404);
  harness.db.close();
});

test("a per-pipeline grant opens exactly one board to exactly one role, read before write", async () => {
  const harness = setup();
  // Owned by nobody, so the grants below are the ONLY thing that can open it: this proves the
  // grant, not `owning_role`, is what widened the view.
  const shop = await created(harness, { owning_role: null });
  const card = await placeCard(harness, SALES_PIPELINE_ID, "new_lead");

  const granted = await call(harness, "POST", `${ADMIN}/${shop.pipeline_id}/roles`, {
    body: {
      expected_version: shop.version,
      // The shop board is read by production and written by ops: more than one role from day one.
      grants: [
        { role: "production", can_write: false },
        { role: "sales", can_write: true },
      ],
    },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.pipeline.role_grants, [
    { role: "production", can_write: false },
    { role: "sales", can_write: true },
  ]);

  // Sales holds a WRITE grant on the shop board and still owns the Sales board it always did.
  const salesList = await boardCall(harness, "GET", "/api/v1/pipelines", { who: "sales" });
  assert.deepEqual(
    (salesList.body.pipelines as Record<string, any>[]).map((pipeline) => [
      pipeline.key,
      pipeline.can_move,
    ]),
    [
      ["sales", true],
      ["shop_production", true],
    ],
  );

  // Production holds a READ grant: the board appears, and the server still refuses the move.
  const productionList = await boardCall(harness, "GET", "/api/v1/pipelines", { who: "production" });
  assert.deepEqual(
    (productionList.body.pipelines as Record<string, any>[]).map((pipeline) => [
      pipeline.key,
      pipeline.can_move,
    ]),
    [["shop_production", false]],
  );
  const readable = await boardCall(harness, "GET", `/api/v1/pipelines/${shop.pipeline_id}/board`, {
    who: "production",
  });
  assert.equal(readable.status, 200);
  assert.ok(!readable.body.allowed_actions.includes("pipeline.card.move"));
  const refused = await boardCall(harness, "POST", `/api/v1/pipelines/${shop.pipeline_id}/cards`, {
    who: "production",
    body: { entity_type: "job", entity_id: "job:board:0001", stage_key: "queued" },
    idempotency: "prod-shop-00000001",
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "pipeline_move_forbidden");

  // The Sales board was never in the grant, so production still cannot see it.
  const other = await boardCall(harness, "GET", `/api/v1/pipelines/${SALES_PIPELINE_ID}/board`, {
    who: "production",
  });
  assert.equal(other.status, 404);
  assert.ok(card.cardId);

  // Revoking is a replace, not a merge: the removed role goes back to the empty state.
  const revoked = await call(harness, "POST", `${ADMIN}/${shop.pipeline_id}/roles`, {
    body: { expected_version: granted.body.pipeline.version, grants: [] },
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const afterRevoke = await boardCall(harness, "GET", "/api/v1/pipelines", { who: "production" });
  assert.deepEqual(afterRevoke.body.pipelines, []);
  harness.db.close();
});

test("a grant may only name a role the account actually has", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const response = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/roles`, {
    body: { expected_version: sales.version, grants: [{ role: "auditor", can_write: true }] },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "pipeline_role_unknown");
  assert.ok((response.body.roles as string[]).includes("owner"));
  harness.db.close();
});

/* ---------------------------------------------------------------- archiving ------ */

test("archiving a board takes it off every board route, and reactivating brings it back", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const archived = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: sales.version, is_active: false },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.pipeline.is_active, false);

  for (const who of ["owner", "sales"] as const) {
    const list = await boardCall(harness, "GET", "/api/v1/pipelines", { who });
    assert.deepEqual(list.body.pipelines, []);
    const board = await boardCall(harness, "GET", `/api/v1/pipelines/${SALES_PIPELINE_ID}/board`, {
      who,
    });
    assert.equal(board.status, 404, `archived board still readable by ${who}`);
  }
  // The administrator still sees it - that is the only surface an archived board appears on.
  const listed = await call(harness, "GET", ADMIN);
  assert.equal(listed.body.pipelines.length, 1);
  assert.equal(listed.body.pipelines[0].is_active, false);

  const restored = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: archived.body.pipeline.version, is_active: true },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const back = await boardCall(harness, "GET", "/api/v1/pipelines", { who: "sales" });
  assert.equal(back.body.pipelines.length, 1);
  harness.db.close();
});

/* ------------------------------------------------------------ tenant isolation ------ */

test("a cross-tenant read or write finds nothing and changes nothing", async () => {
  const harness = setup();
  const foreign = await call(harness, "POST", ADMIN, {
    tenant: OTHER_TENANT,
    body: newPipelineBody({ key: "foreign_board", name: "Foreign board" }),
  });
  assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
  const foreignId = foreign.body.pipeline.pipeline_id as string;
  const foreignStageId = foreign.body.pipeline.stages[0].stage_id as string;

  // Neither tenant's administration list ever mentions the other's board.
  const here = await call(harness, "GET", ADMIN);
  assert.ok(!(here.body.pipelines as Record<string, any>[]).some((p) => p.pipeline_id === foreignId));
  const there = await call(harness, "GET", ADMIN, { tenant: OTHER_TENANT });
  assert.deepEqual(
    (there.body.pipelines as Record<string, any>[]).map((p) => p.key),
    ["foreign_board"],
  );

  const crossTenantWrites: Array<[string, unknown]> = [
    [`${ADMIN}/${foreignId}`, { expected_version: 1, name: "Hijacked" }],
    [`${ADMIN}/${foreignId}/copy`, { key: "stolen", name: "Stolen" }],
    [`${ADMIN}/${foreignId}/roles`, { expected_version: 1, grants: [{ role: "sales" }] }],
    [`${ADMIN}/${foreignId}/stages`, { expected_version: 1, key: "injected", name: "Injected" }],
    [`${ADMIN}/${foreignId}/stages/${foreignStageId}`, { expected_version: 1, name: "Renamed" }],
    [`${ADMIN}/${foreignId}/stages/${foreignStageId}/remove`, { expected_version: 1 }],
    [`${ADMIN}/${foreignId}/stages/order`, { expected_version: 1, stage_ids: [foreignStageId] }],
    [`${ADMIN}/order`, { pipelines: [{ pipeline_id: foreignId, expected_version: 1 }] }],
  ];
  for (const [path, body] of crossTenantWrites) {
    const response = await call(harness, "POST", path, { body });
    assert.equal(response.status, 404, `${path} -> ${JSON.stringify(response.body)}`);
  }
  // And the foreign board is byte-for-byte what it was before every one of those attempts.
  const untouched = await call(harness, "GET", ADMIN, { tenant: OTHER_TENANT });
  assert.deepEqual(untouched.body.pipelines[0], there.body.pipelines[0]);

  // The board routes are isolated on the same terms.
  const board = await handlePipelineRoute(
    request("GET", `/api/v1/pipelines/${foreignId}/board`, { idempotency: null }),
    harness.env,
    auth("owner"),
    NOW,
  );
  assert.equal(board?.status, 404);
  harness.db.close();
});

/* ------------------------------------------------------------- the version CAS ------ */

test("every administration command refuses a stale version with the exact conflict", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const stale = sales.version as number;

  const first = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: stale, name: "Sales pipeline" },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.pipeline.version, stale + 1);

  const commands: Array<[string, Record<string, unknown>]> = [
    [`${ADMIN}/${SALES_PIPELINE_ID}`, { expected_version: stale, name: "Second writer" }],
    [`${ADMIN}/${SALES_PIPELINE_ID}/roles`, { expected_version: stale, grants: [] }],
    [`${ADMIN}/${SALES_PIPELINE_ID}/stages`, { expected_version: stale, key: "late", name: "Late" }],
    [
      `${ADMIN}/${SALES_PIPELINE_ID}/stages/${stageId("new_lead")}`,
      { expected_version: stale, name: "Late rename" },
    ],
    [
      `${ADMIN}/${SALES_PIPELINE_ID}/stages/${stageId("new_lead")}/remove`,
      { expected_version: stale },
    ],
    [
      `${ADMIN}/${SALES_PIPELINE_ID}/stages/order`,
      {
        expected_version: stale,
        stage_ids: (sales.stages as Record<string, any>[]).map((stage) => stage.stage_id),
      },
    ],
  ];
  for (const [path, body] of commands) {
    const response = await call(harness, "POST", path, { body });
    assert.equal(response.status, 409, `${path} -> ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, "pipeline_version_conflict");
    assert.equal(response.body.pipeline_version, stale + 1);
    assert.equal(response.body.expected_version, stale);
  }

  // A stale write is refused, not partially applied: the name the first writer set still stands.
  const after = await seededSales(harness);
  assert.equal(after.version, stale + 1);
  assert.equal(after.name, "Sales pipeline");
  assert.equal((after.stages as Record<string, any>[]).length, sales.stages.length);
  harness.db.close();
});

test("a stale writer cannot ride on the version another command reached", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const stale = sales.version as number;

  // Two administrators hold the same version. The first renames the board.
  const first = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: stale, name: "Winner" },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // The second still holds the stale version and tries to add a stage. Its CAS matches nothing -
  // and the stage insert in the SAME batch must not land on the version the rename reached.
  const second = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/stages`, {
    body: { expected_version: stale, key: "smuggled", name: "Smuggled" },
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "pipeline_version_conflict");

  const stages = harness.db.raw
    .prepare(`SELECT COUNT(*) AS total FROM pipeline_stages WHERE pipeline_id = ? AND key = ?`)
    .get(SALES_PIPELINE_ID, "smuggled") as { total: number };
  assert.equal(Number(stages.total), 0);
  const events = harness.db.raw
    .prepare(
      `SELECT action FROM pipeline_configuration_events WHERE pipeline_id = ? ORDER BY pipeline_version ASC`,
    )
    .all(SALES_PIPELINE_ID) as Record<string, unknown>[];
  assert.deepEqual(
    events.map((event) => event.action),
    ["pipeline_updated"],
  );
  const after = await seededSales(harness);
  assert.equal(after.name, "Winner");
  assert.equal(after.version, stale + 1);
  harness.db.close();
});

test("a command that omits the version is refused before it reaches the database", async () => {
  const harness = setup();
  const response = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { name: "No version" },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "expected_version_required");
  harness.db.close();
});

test("reordering boards carries a version per board and lands as one order", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const second = await created(harness, { key: "second", name: "Second", position: 1 });

  const reordered = await call(harness, "POST", `${ADMIN}/order`, {
    body: {
      pipelines: [
        { pipeline_id: second.pipeline_id, expected_version: second.version },
        { pipeline_id: SALES_PIPELINE_ID, expected_version: sales.version },
      ],
    },
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(
    (reordered.body.pipelines as Record<string, any>[]).map((pipeline) => [
      pipeline.key,
      pipeline.position,
    ]),
    [
      ["second", 0],
      ["sales", 1],
    ],
  );

  const stale = await call(harness, "POST", `${ADMIN}/order`, {
    body: {
      pipelines: [
        { pipeline_id: SALES_PIPELINE_ID, expected_version: sales.version },
        { pipeline_id: second.pipeline_id, expected_version: second.version },
      ],
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "pipeline_version_conflict");
  harness.db.close();
});

test("a multi-board reorder rolls back earlier updates when a later version is stale", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const second = await created(harness, { key: "second", name: "Second", position: 1 });

  // Advance only the later entry. The reorder below still has a valid first entry, which used to
  // commit before the second zero-row CAS was discovered after the batch.
  const winner = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: sales.version, name: "Winner" },
  });
  assert.equal(winner.status, 200, JSON.stringify(winner.body));

  const beforePipelines = harness.db.raw
    .prepare(
      `SELECT pipeline_id, position, version, configuration_marker, name, updated_at
         FROM pipelines WHERE tenant_id = ? ORDER BY pipeline_id ASC`,
    )
    .all(TENANT);
  const beforeEvents = harness.db.raw
    .prepare(
      `SELECT * FROM pipeline_configuration_events
         WHERE tenant_id = ? ORDER BY pipeline_id ASC, pipeline_version ASC, event_id ASC`,
    )
    .all(TENANT);

  const refused = await call(harness, "POST", `${ADMIN}/order`, {
    body: {
      pipelines: [
        { pipeline_id: second.pipeline_id, expected_version: second.version },
        // This is stale: the winner above moved Sales to version 2.
        { pipeline_id: SALES_PIPELINE_ID, expected_version: sales.version },
      ],
    },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "pipeline_version_conflict");

  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT pipeline_id, position, version, configuration_marker, name, updated_at
           FROM pipelines WHERE tenant_id = ? ORDER BY pipeline_id ASC`,
      )
      .all(TENANT),
    beforePipelines,
  );
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT * FROM pipeline_configuration_events
           WHERE tenant_id = ? ORDER BY pipeline_id ASC, pipeline_version ASC, event_id ASC`,
      )
      .all(TENANT),
    beforeEvents,
  );
  harness.db.close();
});

test("a board order must name every board before any reorder batch is opened", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const second = await created(harness, { key: "second", name: "Second", position: 1 });
  const before = harness.db.raw
    .prepare(
      `SELECT pipeline_id, position, version, configuration_marker
         FROM pipelines WHERE tenant_id = ? ORDER BY pipeline_id ASC`,
    )
    .all(TENANT);

  const refused = await call(harness, "POST", `${ADMIN}/order`, {
    body: { pipelines: [{ pipeline_id: second.pipeline_id, expected_version: second.version }] },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "pipeline_order_incomplete");
  assert.deepEqual(
    harness.db.raw
      .prepare(
        `SELECT pipeline_id, position, version, configuration_marker
           FROM pipelines WHERE tenant_id = ? ORDER BY pipeline_id ASC`,
      )
      .all(TENANT),
    before,
  );
  assert.equal(sales.version, 1);
  harness.db.close();
});

/* -------------------------------------------------------- server-owned vocabulary ------ */

test("the administration surface publishes the vocabularies instead of the client hardcoding them", async () => {
  const harness = setup();
  const listed = await call(harness, "GET", ADMIN);
  assert.deepEqual(
    (listed.body.entity_types as Record<string, string>[]).map((entry) => entry.entity_type),
    ["job", "lead"],
  );
  for (const entry of listed.body.entity_types as Record<string, string>[])
    assert.doesNotMatch(entry.label, /roof|shingle|gutter|siding/i);
  assert.deepEqual(listed.body.roles, [
    "owner",
    "ops",
    "sales",
    "production",
    "accounting",
    "field",
  ]);
  assert.equal(listed.body.stage_limit, 200);

  const unknown = await call(harness, "POST", ADMIN, {
    body: newPipelineBody({ key: "bad_entity", entity_type: "unicorn" }),
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "pipeline_entity_type_unknown");
  harness.db.close();
});

/* ----------------------------------------------------------- configuration audit ------ */

test("every configuration change leaves an append-only record of who changed what", async () => {
  const harness = setup();
  const sales = await seededSales(harness);
  const renamed = await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}`, {
    body: { expected_version: sales.version, name: "Sales - Calgary" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  await call(harness, "POST", `${ADMIN}/${SALES_PIPELINE_ID}/roles`, {
    body: { expected_version: renamed.body.pipeline.version, grants: [{ role: "ops", can_write: true }] },
  });

  const events = harness.db.raw
    .prepare(
      `SELECT action, actor_role, actor_id, pipeline_version FROM pipeline_configuration_events
        WHERE tenant_id = ? AND pipeline_id = ? ORDER BY pipeline_version ASC`,
    )
    .all(TENANT, SALES_PIPELINE_ID) as Record<string, unknown>[];
  assert.deepEqual(
    events.map((event) => [event.action, event.actor_role, event.pipeline_version]),
    [
      ["pipeline_updated", "owner", sales.version + 1],
      ["role_grants_replaced", "owner", sales.version + 2],
    ],
  );
  assert.equal(events[0]?.actor_id, "appu_owner_0001");

  assert.throws(
    () =>
      harness.db.raw
        .prepare(`UPDATE pipeline_configuration_events SET action = 'stage_added'`)
        .run(),
    /pipeline_configuration_events_append_only/,
  );
  assert.throws(
    () => harness.db.raw.prepare(`DELETE FROM pipeline_configuration_events`).run(),
    /pipeline_configuration_events_append_only/,
  );
  harness.db.close();
});

/* --------------------------------------------------------------- generic core ------ */

test("nothing in the administration surface names a vertical", async () => {
  const verticals = /\b(roof|roofing|shingle|gutter|siding|eaves|soffit|fascia)\w*/i;
  const migration = readFileSync(
    new URL("../migrations/0122_pipeline_admin_configuration.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(migration, verticals);
  const api = readFileSync(new URL("../src/pipeline-board-api.ts", import.meta.url), "utf8");
  for (const route of api.matchAll(/\/api\/v1\/[A-Za-z0-9/_:$^\\[\]()+*.-]*/g))
    assert.doesNotMatch(route[0], verticals);

  // The stage names an administrator creates are data, and the shipped seed stays the only place
  // the stakeholder's own column names live.
  const harness = setup();
  const created = await call(harness, "POST", ADMIN, {
    body: newPipelineBody({ key: "commercial", name: "Commercial projects" }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    (created.body.pipeline.stages as Record<string, any>[]).map((stage) => stage.name),
    ["Queued", "Cutting", "Ready"],
  );
  harness.db.close();
});
