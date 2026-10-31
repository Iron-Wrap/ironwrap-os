import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

/**
 * The eight named acceptance checks at the end of ELEC-156 section 5, walked in a real
 * browser. Runs against the owner acceptance session (`ACCEPTANCE_MODE=estimator`);
 * `npm run test:pwa:board` is the entry point, and CI runs the same script.
 */

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = process.env.BOARD_SHOT_DIR ?? ".playwright-mobile";

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

/** The undo window the server advertises on every committed transition. */
const SERVER_UNDO_WINDOW_SECONDS = 30;

/**
 * A stateful board fixture: an accepted transition actually moves the card, so the
 * refetch the UI does after a commit reconciles to the new state instead of snapping the
 * card back. That is what the real server does, and it is what the evidence screenshots
 * have to show.
 */
async function installBoardRoutes(page: Page, moves: MoveRequest[], undos: MoveRequest[] = []) {
  const state = structuredClone(boardModel);

  function shiftCard(cardId: string | undefined, toStageId: string | undefined) {
    const card = state.cards.find((candidate) => candidate.card_id === cardId);
    if (!card || !toStageId) return card;
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
    return card;
  }

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
  // The undo route is registered first so its longer path wins over the transitions glob.
  // It undoes for real: the card goes back to the stage it came from, exactly as the
  // server's append-only undo transition does.
  await page.route("**/api/v1/pipelines/pipe-sales/cards/*/transitions/*/undo", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    undos.push({ url: route.request().url(), body });
    const cardId = /\/cards\/([^/]+)\/transitions/.exec(route.request().url())?.[1];
    const card = state.cards.find((candidate) => candidate.card_id === cardId);
    // The route parses `expected_version` before anything else and answers 400 without it.
    if (typeof body.expected_version !== "number") {
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_pipeline_transition" }),
      });
    }
    if (card && card.version !== body.expected_version) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "pipeline_card_version_conflict",
          card_version: card.version,
        }),
      });
    }
    const moved = shiftCard(cardId, "need_quote");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        transition_id: "tr-acceptance-undo",
        card_id: cardId,
        to_stage_id: "need_quote",
        safeguard: "undo",
        card_version: moved?.version ?? 1,
        undo_window_seconds: SERVER_UNDO_WINDOW_SECONDS,
        replayed: false,
      }),
    });
  });
  await page.route("**/api/v1/pipelines/pipe-sales/cards/*/transitions", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    moves.push({ url: route.request().url(), body });
    const cardId = /\/cards\/([^/]+)\/transitions/.exec(route.request().url())?.[1];
    const toStageId = typeof body.to_stage_id === "string" ? body.to_stage_id : undefined;
    const card = shiftCard(cardId, toStageId);
    // `transitionPayload` in workers-bus/src/pipeline-board-api.ts: flat, and carrying the
    // post-move card version that the undo route requires back as `expected_version`.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        transition_id: "tr-acceptance",
        card_id: cardId,
        to_stage_id: toStageId,
        safeguard: "none",
        card_version: card?.version ?? 1,
        undo_window_seconds: SERVER_UNDO_WINDOW_SECONDS,
        replayed: false,
      }),
    });
  });
}

/**
 * The board title is legible, not merely present in the DOM. A `min-w-0` heading in a flex
 * row can be squeezed to a few pixels wide and still "render": Playwright then reports it
 * hidden the moment that width reaches zero, which is how this was first caught.
 */
async function expectReadableBoardTitle(page: Page, name: string) {
  const heading = page.getByRole("heading", { name });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box?.width ?? 0, `width of the board title "${name}"`).toBeGreaterThanOrEqual(120);
  // One line, not a vertical column of characters.
  expect(box?.height ?? 0, `height of the board title "${name}"`).toBeLessThanOrEqual(60);
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
    test(`reads as a board at ${viewport.label} without a sideways page`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installBoardRoutes(page, []);
      await page.goto("/owner/board");

      await expect(page.getByRole("heading", { name: "Sales · Marketing Pipeline" })).toBeVisible();
      for (const name of stageNames) {
        await expect(page.getByRole("region", { name: `${name} column` })).toBeAttached();
      }
      await expect(page.getByText("$6,414,205.40")).toBeVisible();
      await expect(page.getByText("WON").first()).toBeVisible();
      await expect(page.getByText("3 loaded · 118 total · 7 stages")).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Quote Sent column" })
          .getByText("No cards from this stage in the loaded list"),
      ).toBeAttached();

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
        const label = await controls.nth(index).innerText();
        await expectTouchTarget(controls.nth(index), { name: label });
      }

      await page.screenshot({
        path: `${shotDir}/pipeline-board-${viewport.label}-${testInfo.project.name}.png`,
      });

      await page.goto("/estimator/jobs/JOB-ESTIMATOR-ACCEPTANCE");
      await expect(page.getByRole("heading", { name: "Roof and quote review" })).toBeVisible();
      const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
      const compactStatus = page.locator('[aria-label="App status"]');
      if (await compactStatus.isVisible()) {
        const crumbBox = await breadcrumb.boundingBox();
        const statusBox = await compactStatus.boundingBox();
        expect(crumbBox).not.toBeNull();
        expect(statusBox).not.toBeNull();
        expect(crumbBox!.x + crumbBox!.width).toBeLessThanOrEqual(statusBox!.x + 1);
        if (viewport.width === 768) {
          expect(crumbBox!.width).toBeGreaterThan(48);
          const statusWidth = await compactStatus.evaluate((element) => ({
            content: element.scrollWidth,
            visible: element.clientWidth,
          }));
          expect(statusWidth.content).toBeLessThanOrEqual(statusWidth.visible + 1);
          await expect(breadcrumb.locator("a")).toBeHidden();
        }
      }
      await expectTouchTarget(page.getByRole("button", { name: "Search work" }));
      await expectTouchTarget(page.getByRole("button", { name: "Safety", exact: true }));
      await page.screenshot({
        path: `${shotDir}/review-overview-${viewport.label}-${testInfo.project.name}.png`,
      });
      if (viewport.width < 640) {
        await page.getByRole("link", { name: "See what needs review" }).click();
        await expect(page.locator("#proposal-readiness-heading")).toBeFocused();
        await expect(page.locator('details[aria-labelledby="proposal-heading"]')).toHaveAttribute(
          "open",
        );
        const reviewBox = await page.locator("#proposal-readiness-heading").boundingBox();
        expect(reviewBox!.y).toBeGreaterThanOrEqual(56);
        expect(reviewBox!.y).toBeLessThan(viewport.height / 2);
      }
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
    await expectTouchTarget(undo, { name: "Undo", axis: "height" });

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
      await expectTouchTarget(dialog.getByRole("button", { name }), {
        name,
        min: 48,
        axis: "height",
      });
    }

    await dialog.getByRole("button", { name: "Confirm move" }).click();
    await expect(page.getByText("Moved to New Lead")).toBeVisible();
    expect(moves[0]?.body).toMatchObject({ to_stage_id: "new_lead", confirmed: true });
  });

  /**
   * The undo half of the safe move, walked on a phone against a server that actually
   * undoes: the card comes back to the stage it left, and the request carries the
   * post-move `expected_version` the route refuses an undo without.
   */
  test("undoes a committed move on a phone and returns the card to its stage", async ({ page }) => {
    const moves: MoveRequest[] = [];
    const undos: MoveRequest[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, moves, undos);
    await page.goto("/owner/board");

    const card = page.getByRole("article", { name: "Naina Tamang" });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: /^Move/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Quote Sent/ })
      .click();
    await expect(page.getByText("Moved to Quote Sent")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Quote Sent column" }).getByRole("article", {
        name: "Naina Tamang",
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();

    await expect(page.getByText("Move undone. Card is back in Need Quote.")).toBeVisible();
    await page.screenshot({ path: `${shotDir}/pipeline-board-undo-restored.png` });
    // The card is back in the column it left, on the board the server re-read.
    await expect(
      page.getByRole("region", { name: "Need Quote column" }).getByRole("article", {
        name: "Naina Tamang",
      }),
    ).toBeVisible();
    expect(undos).toHaveLength(1);
    // Version 7 before the move, 8 after it: the undo has to present the post-move token.
    expect(undos[0]?.body).toMatchObject({ expected_version: 8 });
  });

  // The rejected-by-server half: the exact blocker, with the server's own facts in it.
  test("renders the server's exact stale-version blocker instead of a generic failure", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBoardRoutes(page, []);
    await page.unroute("**/api/v1/pipelines/pipe-sales/cards/*/transitions");
    await page.route("**/api/v1/pipelines/pipe-sales/cards/*/transitions", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "pipeline_card_version_conflict", card_version: 9 }),
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

    await expect(page.getByRole("alert")).toContainText(
      /Someone else changed this card first\. The board has been refreshed/,
    );
    await page.screenshot({ path: `${shotDir}/pipeline-board-version-conflict.png` });
    // Rolled back: the card is still in the column it started in.
    await expect(
      page.getByRole("region", { name: "Need Quote column" }).getByRole("article", {
        name: "Naina Tamang",
      }),
    ).toBeVisible();
  });

  /**
   * An account holds as many boards as it configures, and the switcher is not owner-only:
   * whoever the server returns two boards to reaches both of them, on a phone.
   *
   * 360px as well as 390px, because a `select` sizes itself to its widest option and the
   * header has to survive that: at 390px with a classic scrollbar the usable row is 375px,
   * which is what collapsed the board title to a zero-width sliver before the header was
   * allowed to wrap. The title floor below is the assertion that pins it.
   */
  for (const width of [360, 390]) {
    test(`switches between two boards on a ${width}px-wide phone`, async ({ page }) => {
      const resale = {
        ...pipeline,
        pipeline_id: "pipe-resale",
        key: "resale",
        name: "Material resale",
      };
      await page.setViewportSize({ width, height: 844 });
      await installBoardRoutes(page, []);
      await page.unroute("**/api/v1/pipelines");
      await page.route("**/api/v1/pipelines", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...envelope, pipelines: [pipeline, resale] }),
        }),
      );
      await page.route("**/api/v1/pipelines/pipe-resale/board", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...boardModel, pipeline: resale, cards: [] }),
        }),
      );
      await page.goto("/owner/board");

      const switcher = page.getByRole("combobox", { name: "Pipeline" });
      await expectTouchTarget(switcher, { name: "Pipeline switcher", axis: "height" });
      // The switcher may never set the width of the header: whatever an account named its
      // boards, the title beside it stays readable rather than being squeezed to a sliver.
      await expectReadableBoardTitle(page, "Sales · Marketing Pipeline");
      if (width === 390) {
        await page.screenshot({ path: `${shotDir}/pipeline-board-pipeline-switcher.png` });
      }

      await switcher.selectOption("pipe-resale");
      await expect(page.getByRole("heading", { name: "Material resale" })).toBeVisible();
      await expectReadableBoardTitle(page, "Material resale");
      const geometry = await pageOverflow(page);
      expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    });
  }

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
        body: JSON.stringify({ error: "stage_entry_role_required", required_role: "production" }),
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

    await expect(page.getByRole("alert")).toContainText(
      /Your role cannot move a card into Quote Sent\. It is reserved for production/,
    );
    await expect(
      page.getByRole("region", { name: "Need Quote column" }).getByRole("article", {
        name: "Naina Tamang",
      }),
    ).toBeVisible();
    await page.screenshot({ path: `${shotDir}/pipeline-board-refused.png` });
  });
});
