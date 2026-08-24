import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

/**
 * The eight named acceptance checks at the end of ELEC-156 section 5, walked in a real
 * browser. Runs against the owner acceptance session (`ACCEPTANCE_MODE=estimator`);
 * `npm run test:pwa:board` is the entry point, and CI runs the same script.
 */

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const HIT_TARGET_MIN_PX = 43.99;

const envelope = {
  version: 1,
  source_updated_at: "2026-08-22T12:00:00.000Z",
  read_model_generated_at: "2026-08-22T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.card.move"],
};

const pipeline = {
  pipeline_id: "pipe-sales",
  key: "sales",
  name: "Sales · Marketing Pipeline",
  entity_type: "lead",
  owning_role: "sales",
  position: 0,
};

const stageNames = [
  "New Lead",
  "Visit Booked",
  "Need Quote",
  "Quote Sent",
  "Contract signed",
  "Deposit",
  "Materials in prod",
];

function stageId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

const boardModel = {
  ...envelope,
  pipeline,
  stages: stageNames.map((name, position) => ({
    stage_id: stageId(name),
    key: stageId(name),
    name,
    position,
    is_won: name === "Contract signed",
    is_lost: false,
    card_count:
      name === "New Lead"
        ? 1
        : name === "Need Quote"
          ? 1
          : name === "Quote Sent"
            ? 115
            : name === "Contract signed"
              ? 1
              : 0,
    total_amount_cents:
      name === "Quote Sent"
        ? 641_420_540
        : name === "Contract signed"
          ? 1_450_000
          : name === "Need Quote"
            ? 400_000
            : 0,
    min_role_to_enter: null,
  })),
  cards: [
    {
      card_id: "card-lead",
      stage_id: "new_lead",
      position_in_stage: 10,
      entity_type: "lead",
      entity_id: "lead-1",
      version: 1,
      summary: { title: "Jubril Mcgregor", counters: [{ kind: "messages", count: 1 }] },
    },
    {
      card_id: "card-quote",
      stage_id: "need_quote",
      position_in_stage: 10,
      entity_type: "lead",
      entity_id: "lead-2",
      version: 7,
      summary: {
        title: "Naina Tamang",
        amount_cents: 400_000,
        identifiers: [{ label: "Lead", value: "26-219-ER" }],
        tags: ["Metal Roofing"],
        counters: [
          { kind: "messages", count: 2 },
          { kind: "files", count: 8 },
        ],
        is_won: false,
      },
    },
    {
      card_id: "card-won",
      stage_id: "contract_signed",
      position_in_stage: 10,
      entity_type: "lead",
      entity_id: "lead-3",
      version: 2,
      summary: {
        title: "Petre Milouchev",
        amount_cents: 1_450_000,
        identifiers: [
          { label: "Lead", value: "26-058-ABN" },
          { label: "Job", value: "ABN26-004" },
        ],
        tags: ["Metal Roofing", "Soffit"],
        counters: [{ kind: "messages", count: 2 }],
        is_won: true,
      },
    },
  ],
};

interface MoveRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A stateful board fixture: an accepted transition actually moves the card, so the
 * refetch the UI does after a commit reconciles to the new state instead of snapping the
 * card back. That is what the real server does, and it is what the evidence screenshots
 * have to show.
 */
async function installBoardRoutes(page: Page, moves: MoveRequest[]) {
  const state = structuredClone(boardModel);

  await page.route("**/api/v1/pipelines", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...envelope, pipelines: [pipeline] }),
    }),
  );
  await page.route("**/api/v1/pipelines/pipe-sales/board", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.route("**/api/v1/pipelines/pipe-sales/cards/*/transitions", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    moves.push({ url: route.request().url(), body });
    const cardId = /\/cards\/([^/]+)\/transitions/.exec(route.request().url())?.[1];
    const card = state.cards.find((candidate) => candidate.card_id === cardId);
    const toStageId = typeof body.to_stage_id === "string" ? body.to_stage_id : undefined;
    if (card && toStageId) {
      const amount = card.summary.amount_cents ?? 0;
      for (const item of state.stages) {
        if (item.stage_id === card.stage_id) {
          item.card_count -= 1;
          item.total_amount_cents -= amount;
        } else if (item.stage_id === toStageId) {
          item.card_count += 1;
          item.total_amount_cents += amount;
        }
      }
      card.stage_id = toStageId;
      card.version += 1;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transition_id: "tr-acceptance" }),
    });
  });
}

async function pageOverflow(page: Page) {
  return await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
}

test.describe("Pipeline board acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  // Checks 1, 2, 3 and 4: every named viewport, no page-level horizontal scroll, and the
  // 44px hit-target floor on everything the board makes interactive.
  for (const viewport of [
    { label: "mobile-390x844", width: 390, height: 844 },
    { label: "tablet-768x1024", width: 768, height: 1024 },
    { label: "desktop-1280x800", width: 1280, height: 800 },
    { label: "desktop-1440x900", width: 1440, height: 900 },
  ]) {
    test(`reads as a board at ${viewport.label} without a sideways page`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installBoardRoutes(page, []);
      await page.goto("/owner/board");

      await expect(page.getByRole("heading", { name: "Sales · Marketing Pipeline" })).toBeVisible();
      for (const name of stageNames) {
        await expect(page.getByRole("region", { name: `${name} column` })).toBeAttached();
      }
      await expect(page.getByText("$6,414,205.40")).toBeVisible();
      await expect(page.getByText("WON").first()).toBeVisible();

      const geometry = await pageOverflow(page);
      expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);

      const firstColumn = page.getByRole("region", { name: "New Lead column" });
      const columnWidth = (await firstColumn.boundingBox())?.width ?? 0;
      const chipRow = page.getByRole("button", { name: /^New Lead 1$/ });

      if (viewport.width < 640) {
        // Stage Pager: one column, full width, every stage still enumerated in the chips.
        expect(columnWidth).toBeGreaterThan(viewport.width * 0.85);
        await expect(chipRow).toBeVisible();
      } else if (viewport.width < 1024) {
        // Peek Scroll: ~85vw active column, so the next column's edge stays on screen.
        expect(columnWidth).toBeGreaterThan(viewport.width * 0.7);
        expect(columnWidth).toBeLessThan(viewport.width * 0.95);
        await expect(chipRow).toBeVisible();
      } else {
        // Full Board: fixed-width columns, chips gone. The spec's density check is four
        // columns at 1440 — with this app's 15.5rem sidebar that sets the column width,
        // which is why it is 16.5rem here rather than the spec's sidebar-less 18.75rem.
        expect(columnWidth).toBeGreaterThan(250);
        expect(columnWidth).toBeLessThan(300);
        await expect(chipRow).toBeHidden();
        const visibleColumns = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          return [...document.querySelectorAll("[data-stage-column]")].filter((column) => {
            const box = column.getBoundingClientRect();
            return box.left >= -1 && box.right <= width + 1;
          }).length;
        });
        expect(visibleColumns).toBeGreaterThanOrEqual(viewport.width >= 1440 ? 4 : 3);
      }

      const controls = page.locator("main button:visible");
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const box = await controls.nth(index).boundingBox();
        const label = await controls.nth(index).innerText();
        // 44px, measured with a hair of tolerance: a `min-h-11` box lands on
        // 43.99998px once the layout engine has rounded rem to device pixels.
        expect(box?.height ?? 0, `height of "${label}"`).toBeGreaterThanOrEqual(HIT_TARGET_MIN_PX);
        expect(box?.width ?? 0, `width of "${label}"`).toBeGreaterThanOrEqual(HIT_TARGET_MIN_PX);
      }

      await page.screenshot({ path: `${shotDir}/pipeline-board-${viewport.label}.png` });
    });
  }

  // Check 6 plus the safeguard rule (PO decision D2): adjacent-forward is direct, and
  // Undo is the accident protection for it.
  test("commits an adjacent-forward move directly and offers Undo for five seconds", async ({
    page,
  }) => {
    const moves: MoveRequest[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, moves);
    await page.goto("/owner/board");

    const card = page.getByRole("article", { name: "Naina Tamang" });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: /^Move/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Quote Sent/ }).click();

    await expect(page.getByText("Moved to Quote Sent")).toBeVisible();
    expect(moves).toHaveLength(1);
    expect(moves[0]?.body).toMatchObject({ to_stage_id: "quote_sent", expected_version: 7 });
    expect(moves[0]?.body).not.toHaveProperty("confirmed");

    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    expect((await undo.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // The toast sits above the bottom nav, not under it.
    const toastBox = await page.getByText("Moved to Quote Sent").boundingBox();
    const navBox = await page.getByRole("navigation", { name: "Main navigation" }).boundingBox();
    expect((toastBox?.y ?? 0) + (toastBox?.height ?? 0)).toBeLessThanOrEqual(navBox?.y ?? 0);

    await page.screenshot({ path: `${shotDir}/pipeline-board-undo-toast.png` });

    // Check 6: the affordance is gone once the 5000ms window closes.
    await expect(undo).toBeHidden({ timeout: 9_000 });
  });

  // Check 4 (48px confirm pair) and the confirmation half of PO decision D2.
  test("takes one confirm before a backward move and sends it as confirmed", async ({ page }) => {
    const moves: MoveRequest[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, moves);
    await page.goto("/owner/board");

    const card = page.getByRole("article", { name: "Naina Tamang" });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: /^Move/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^New Lead/ }).click();

    await expect(page.getByText(/Move backward to New Lead\?/)).toBeVisible();
    expect(moves).toHaveLength(0);
    await page.screenshot({ path: `${shotDir}/pipeline-board-backward-confirm.png` });

    for (const name of ["Cancel", "Confirm move"]) {
      const box = await dialog.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(48);
    }

    await dialog.getByRole("button", { name: "Confirm move" }).click();
    await expect(page.getByText("Moved to New Lead")).toBeVisible();
    expect(moves[0]?.body).toMatchObject({ to_stage_id: "new_lead", confirmed: true });
  });

  // Check 7: the whole journey, keyboard only, ending in a backward confirm.
  test("moves a card backward with the keyboard alone", async ({ page }) => {
    const moves: MoveRequest[] = [];
    await page.setViewportSize({ width: 1280, height: 800 });
    await installBoardRoutes(page, moves);
    await page.goto("/owner/board");

    const moveButton = page
      .getByRole("article", { name: "Naina Tamang" })
      .getByRole("button", { name: /^Move/ });
    await expect(moveButton).toBeVisible();
    await moveButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /^New Lead/ })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByText(/Move backward to New Lead\?/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Confirm move" })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByText("Moved to New Lead")).toBeVisible();
    expect(moves[0]?.body).toMatchObject({ to_stage_id: "new_lead", confirmed: true });
  });

  // Check 8: reduced motion is honoured through the global tokens. The companion source
  // check that no component overrides them is src/pipeline/pipeline-surface.family.test.ts.
  test("honours prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, []);
    await page.goto("/owner/board");

    const card = page.getByRole("article", { name: "Naina Tamang" });
    await expect(card).toBeVisible();
    const durations = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.transitionDuration, style.animationDuration];
    });
    for (const duration of durations) {
      for (const part of duration.split(",")) {
        const seconds = part.trim().endsWith("ms")
          ? Number.parseFloat(part) / 1000
          : Number.parseFloat(part);
        expect(seconds).toBeLessThanOrEqual(0.001);
      }
    }
  });

  test("refuses the move in the UI when the read model grants no move action", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/v1/pipelines", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...envelope, pipelines: [pipeline] }),
      }),
    );
    await page.route("**/api/v1/pipelines/pipe-sales/board", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...boardModel, allowed_actions: ["pipeline.read"] }),
      }),
    );
    await page.goto("/owner/board");

    await expect(page.getByText("Read only")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Move/ })).toHaveCount(0);
    await page.screenshot({ path: `${shotDir}/pipeline-board-read-only.png` });
  });

  test("rolls the card back and says why when the server refuses the move", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, []);
    await page.unroute("**/api/v1/pipelines/pipe-sales/cards/*/transitions");
    await page.route("**/api/v1/pipelines/pipe-sales/cards/*/transitions", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "stage_entry_role_required" }),
      }),
    );
    await page.goto("/owner/board");

    const card = page.getByRole("article", { name: "Naina Tamang" });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: /^Move/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Quote Sent/ })
      .click();

    await expect(page.getByRole("alert")).toContainText(/cannot move a card into that stage/);
    await expect(
      page.getByRole("region", { name: "Need Quote column" }).getByRole("article", {
        name: "Naina Tamang",
      }),
    ).toBeVisible();
    await page.screenshot({ path: `${shotDir}/pipeline-board-refused.png` });
  });
});
