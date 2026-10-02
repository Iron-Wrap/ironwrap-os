import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

/**
 * ELEC-202 acceptance, walked in a real browser at a phone viewport: a lead added through the
 * product UI reaches a pipeline board through the product UI, and the board's Move dialog refuses
 * an offline move instead of pretending one is possible.
 *
 * `npm run test:pwa:placement` is the entry point. The fixture is stateful on purpose — a
 * placement really adds the card to the board payload, so the screenshots show the card the
 * journey created rather than one the fixture seeded.
 */

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const PHONE = { width: 390, height: 844 };
const leadId = `lead:ironwrap:${"b".repeat(64)}`;

const envelope = {
  version: 1,
  source_updated_at: "2026-08-28T12:00:00.000Z",
  read_model_generated_at: "2026-08-28T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.card.move"],
};

const salesPipeline = {
  pipeline_id: "pipe-sales",
  key: "sales",
  name: "Sales",
  entity_type: "lead",
  owning_role: "sales",
  can_move: true,
  card_count: 0,
  position: 0,
};

/**
 * A board this session may read but not write: the administrator granted read access to it and
 * nothing more, so the server answers `can_move: false`. It binds the SAME entity type as the
 * sales board, which is the point — the entity type is not what disqualifies it, the role scope is.
 */
const readOnlyPipeline = {
  pipeline_id: "pipe-commercial",
  key: "commercial",
  name: "Commercial projects",
  entity_type: "lead",
  owning_role: "ops",
  can_move: false,
  card_count: 0,
  position: 1,
};

const stageNames = ["New Lead", "Visit Booked", "Quote Sent", "Contract signed"];

function stageId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

function emptyBoard() {
  return {
    ...envelope,
    pipeline: salesPipeline,
    stages: stageNames.map((name, position) => ({
      stage_id: stageId(name),
      key: stageId(name),
      name,
      position,
      is_won: name === "Contract signed",
      is_lost: false,
      card_count: 0,
      total_amount_cents: 0,
      min_role_to_enter: null,
    })),
    cards: [] as Array<Record<string, unknown>>,
  };
}

function salesLead(id: string, displayName: string) {
  return {
    id,
    envelope_id: `env_${id.toLowerCase()}`,
    source: "office",
    received_at: "2026-08-28T12:00:00.000Z",
    transport_status: "received",
    intent_queue: "Estimator",
    contact: { display_name: displayName, phone: null, email: "pat@example.invalid" },
    // A lead nobody has looked at yet, which is what "just added" actually is — and what puts
    // it in the desk's default "Needs a check" view.
    triage: { status: "Untriaged", summary: null, version: 1 },
    job: null,
    estimate: null,
    quote: null,
    proposal: null,
    consent: { context: "no_linked_record", records: [] },
    partial_fields: [],
    attention: ["triage_unresolved"],
  };
}

function emptySales() {
  return {
    version: 1,
    source_updated_at: "2026-08-28T12:00:00.000Z",
    read_model_generated_at: "2026-08-28T12:00:01.000Z",
    stale_fields: [],
    permissions: ["sales:read"],
    allowed_actions: ["sales.read", "sales.lead.create"],
    partial_sources: [],
    summary: {
      listed_leads: 0,
      triage_unresolved: 0,
      estimate_needs_review: 0,
      quote_needs_review: 0,
      quote_expired: 0,
      no_linked_consent_record: 0,
    },
    leads: [] as ReturnType<typeof salesLead>[],
  };
}

interface Placement {
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

/**
 * One fixture for the whole journey. Creating a lead really appends it to the sales read model,
 * and placing a card really appends it to the board — including the server's own idempotency:
 * a second placement of the same entity answers 200 `replayed` with the SAME card, never a second
 * one, because the card id is derived from `(tenant, pipeline, entity_type, entity_id)`.
 */
async function installRoutes(page: Page, placements: Placement[]) {
  const sales = emptySales();
  const board = emptyBoard();
  let receipt: Record<string, unknown> | undefined;

  await page.route("**/api/v1/sales/leads?include_receipt=1", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, string>;
    const key = route.request().headers()["idempotency-key"];
    expect(key).toMatch(/^office-lead:[0-9a-f-]{36}$/);
    sales.leads.push(salesLead(leadId, body.name ?? "Unnamed"));
    sales.summary.listed_leads = sales.leads.length;
    sales.summary.triage_unresolved = sales.leads.length;
    receipt = {
      version: 1,
      receipt: {
        request_id: key,
        state: "recorded",
        outcome: "created",
        canonical_envelope_id: sales.leads[0]!.envelope_id,
        lead_id: leadId,
        submitted_details_applied: true,
        captured_at: "2026-09-30T12:00:00.000Z",
        details: {
          name: body.name,
          email: body.email || null,
          phone: body.phone || null,
          address: body.address || null,
          city: body.city || null,
          province: body.province || null,
          postal_code: body.postal_code || null,
          service: body.service || null,
          message: body.message || null,
          source: "office",
          intake_source: "phone",
          preferred_contact_channel: null,
          email_consent: {
            status: "not_recorded",
            purpose: "estimate_follow_up",
            recorded_at: null,
            captured_by: null,
            jurisdiction: null,
            wording_version: null,
          },
        },
      },
    };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(receipt),
    });
  });
  await page.route("**/api/v1/sales/intakes/*", (route) => route.fulfill({ json: receipt }));

  await page.route("**/api/v1/sales", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sales),
    }),
  );

  await page.route("**/api/v1/pipelines", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...envelope,
        pipelines: [{ ...salesPipeline, card_count: board.cards.length }, readOnlyPipeline],
      }),
    }),
  );

  await page.route("**/api/v1/pipelines/pipe-sales/cards", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    placements.push({
      body,
      idempotencyKey: route.request().headers()["idempotency-key"],
    });
    if (body.entity_type !== salesPipeline.entity_type) {
      return await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "pipeline_entity_type_mismatch" }),
      });
    }
    const cardId = `plc_${String(body.entity_id)}`;
    const existing = board.cards.find((card) => card.card_id === cardId);
    if (!existing) {
      board.cards.push({
        card_id: cardId,
        stage_id: stageId(stageNames[0]!),
        position_in_stage: 10,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        version: 1,
        summary: { title: "Pat Prospect" },
      });
      board.stages[0]!.card_count += 1;
    }
    return await route.fulfill({
      status: existing ? 200 : 201,
      contentType: "application/json",
      body: JSON.stringify({
        card_id: cardId,
        pipeline_id: "pipe-sales",
        stage_id: stageId(stageNames[0]!),
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        card_version: 1,
        transition_id: "pct_placement",
        replayed: Boolean(existing),
      }),
    });
  });

  await page.route("**/api/v1/pipelines/pipe-sales/board", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(board),
    }),
  );
}

test.describe("Lead onto a pipeline board", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("a lead added in the UI reaches a board through the UI, on a phone", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    const placements: Placement[] = [];
    await installRoutes(page, placements);

    // 1. Add the lead the way the office actually does.
    await page.goto("/sales/new-lead");
    await expect(page.getByRole("heading", { name: "Add a lead" })).toBeVisible();
    await page.getByLabel("Full name", { exact: true }).fill("Pat Prospect");
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("pat@example.invalid");
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Sales desk", exact: true }).last().click();

    // 2. It lands on the sales desk, and the desk now offers a board for it.
    await expect(page.getByRole("heading", { name: "Sales desk" })).toBeVisible();
    const addToBoard = page.getByRole("button", { name: "Add Pat Prospect to a board" });
    await expectTouchTarget(addToBoard, { name: "Add Pat Prospect to a board", axis: "height" });
    await page.screenshot({ path: `${shotDir}/placement-1-sales-desk.png` });

    // 3. Only the board the server says this session may write is offered.
    await addToBoard.click();
    const dialog = page.getByRole("dialog", { name: "Add to a board" });
    await expect(dialog.getByRole("button", { name: /^Sales/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Commercial projects/ })).toHaveCount(0);
    await page.screenshot({ path: `${shotDir}/placement-2-choose-board.png` });

    await dialog.getByRole("button", { name: /^Sales/ }).click();
    await expect(page.getByText("Pat Prospect is on Sales, in its first stage.")).toBeVisible();
    await page.screenshot({ path: `${shotDir}/placement-3-placed.png` });

    // The command the server actually received.
    expect(placements).toHaveLength(1);
    expect(placements[0]?.body).toMatchObject({ entity_type: "lead", entity_id: leadId });
    expect(placements[0]?.idempotencyKey).toMatch(/^pipeline-card-place:/);

    // 4. The board shows the card the journey created.
    await page.getByRole("link", { name: "Open the board" }).click();
    await expect(page.getByRole("heading", { name: "Sales", level: 1 })).toBeVisible();
    const column = page.getByRole("region", { name: "New Lead column" });
    await expect(column.getByRole("article", { name: "Pat Prospect" })).toBeVisible();

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    await page.screenshot({ path: `${shotDir}/placement-4-board.png` });

    // 5. Repeat placement is idempotent: still one card, and the surface says so.
    await page.goto("/sales");
    await page.getByRole("button", { name: "Add Pat Prospect to a board" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Sales/ })
      .click();
    await expect(page.getByText("Pat Prospect is on Sales, in its first stage.")).toBeVisible();
    expect(placements).toHaveLength(2);
    await page.getByRole("link", { name: "Open the board" }).click();
    await expect(column.getByRole("article", { name: "Pat Prospect" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^New Lead 1$/ })).toBeVisible();
  });

  test("the Move dialog refuses an offline move instead of offering every stage", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    const placements: Placement[] = [];
    await installRoutes(page, placements);

    // Get one card onto the board first, through the product path.
    await page.goto("/sales/new-lead");
    await page.getByLabel("Full name", { exact: true }).fill("Pat Prospect");
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("pat@example.invalid");
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Sales desk", exact: true }).last().click();
    await page.getByRole("button", { name: "Add Pat Prospect to a board" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Sales/ })
      .click();
    await page.getByRole("link", { name: "Open the board" }).click();
    await expect(page.getByRole("article", { name: "Pat Prospect" })).toBeVisible();

    // Routed responses are still served offline, so the board stays readable — which is
    // exactly the state the defect describes: readable board, silently unusable Move.
    await page.context().setOffline(true);
    await expect(page.getByText("Offline: the board is read-only")).toBeVisible();

    const card = page.getByRole("article", { name: "Pat Prospect" });
    await card.getByRole("button", { name: /^Move/ }).click();
    const moveDialog = page.getByRole("dialog", { name: /^Move/ });
    await expect(moveDialog.getByText("Offline: this card cannot be moved")).toBeVisible();
    for (const name of stageNames.slice(1)) {
      await expect(moveDialog.getByRole("button", { name: new RegExp(name) })).toBeDisabled();
    }
    await page.screenshot({ path: `${shotDir}/placement-5-offline-move.png` });

    await page.context().setOffline(false);
    await expect(moveDialog.getByRole("button", { name: /Quote Sent/ })).toBeEnabled();
    expect(testInfo.status).not.toBe("failed");
  });
});
