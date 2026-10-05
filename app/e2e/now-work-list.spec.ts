import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { NowResponse } from "../src/now/now-contracts";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = process.env.NOW_SHOT_DIR ?? ".playwright-mobile";

const nowResponse = {
  version: 1,
  role: "owner",
  read_model_generated_at: "2026-08-21T12:00:00.000Z",
  permissions: ["owner.now.read"],
  allowed_actions: ["job.read"],
  sources: [
    {
      id: "owner",
      state: "current",
      read_model_generated_at: "2026-08-21T12:00:00.000Z",
      stale_fields: [],
    },
    {
      id: "facet",
      state: "current",
      read_model_generated_at: "2026-08-21T11:59:00.000Z",
      stale_fields: [],
    },
    {
      id: "production",
      state: "limited",
      read_model_generated_at: "2026-08-21T11:58:00.000Z",
      stale_fields: ["partial.materials"],
    },
    {
      id: "sales",
      state: "current",
      read_model_generated_at: "2026-08-21T11:57:00.000Z",
      stale_fields: [],
    },
  ],
  ui: {
    schema_version: 1,
    state: "limited",
    title: "Work to do now",
    explanation:
      "IronWrap puts the most important work here. Start with the first item, finish it, then come back.",
    sync_label:
      "Some lists did not load or may be missing items. IronWrap will not mark them as done.",
    primary_action: {
      id: "now:refresh",
      label: "Check all lists again",
      kind: "refresh",
      href: null,
      reason: "One or more work lists did not load, so IronWrap cannot pick the next step yet.",
      citation_ids: [],
    },
    sections: [
      {
        id: "exceptions",
        title: "Check first",
        summary: "1 item needs a check",
        cards: [
          {
            id: "owner:gate-e2e",
            tone: "critical",
            eyebrow: "Fix first",
            title: "Material drop is not confirmed",
            detail: "The crew cannot start until the shingles are on site.",
            action: {
              id: "owner:gate-e2e:action",
              label: "Open item",
              kind: "navigate",
              href: "/owner",
              reason: "Open the work record and choose the next safe step.",
              citation_ids: ["owner:gate-e2e"],
            },
            citations: [
              {
                id: "owner:gate-e2e",
                label: "Work record",
                source: "owned_read_model",
                href: "/owner",
              },
            ],
          },
        ],
      },
      {
        id: "production",
        title: "Keep jobs moving",
        summary: "No job needs a check in this loaded list.",
        cards: [],
      },
    ],
  },
} satisfies NowResponse;

test.describe("Now work list acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows one clear next step with system details closed", async ({ page }, testInfo) => {
    await page.route("**/api/v1/now*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(nowResponse),
      }),
    );
    await page.route("**/api/v1/operating-intake", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          operating_authority: "d1",
          tenant_id: "ironwrap",
          generated_at: "2026-08-21T16:00:00.000Z",
          leads: [],
        }),
      }),
    );

    await page.goto("/now");

    await expect(page.getByRole("heading", { name: "Work to do now" })).toBeVisible();
    await expect(page.getByText("Some lists did not load or may be missing items.")).toBeVisible();
    const mainAction = page.getByRole("button", { name: "Check all lists again" });
    await expectTouchTarget(mainAction, { name: "Check all lists again", axis: "height" });
    await expect(page.getByRole("link", { name: "Open item" })).toHaveAttribute("href", "/owner");
    await expect(page.getByText("No website leads in this loaded list.")).toBeVisible();
    const urgentRow = await page
      .getByRole("button", { name: "Material drop is not confirmed" })
      .boundingBox();
    const intake = await page.getByRole("heading", { name: "Website intake" }).boundingBox();
    expect(urgentRow).not.toBeNull();
    expect(intake).not.toBeNull();
    expect(urgentRow!.y + urgentRow!.height).toBeLessThan(intake!.y);

    const listStatus = page.getByRole("complementary", { name: "List status" });
    await expect(listStatus.getByText("System details")).toBeVisible();
    await expect(listStatus.getByRole("list", { name: "Work list status" })).toBeHidden();

    const size = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(size.page).toBeLessThanOrEqual(size.view + 1);
    await page.screenshot({ path: `${shotDir}/now-work-list-${testInfo.project.name}.png` });

    await listStatus.getByText("System details").click();
    await expect(listStatus.getByText("Jobs", { exact: true })).toBeVisible();
    await expect(listStatus.getByText("Needs a check", { exact: true })).toBeVisible();
  });
  test("selects dense rows and filters the server sections on desktop", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile-chromium", "desktop inspector path");
    await page.setViewportSize({ width: 1440, height: 900 });
    const model = structuredClone(nowResponse);
    model.ui.sections[0].cards.push({
      ...model.ui.sections[0].cards[0],
      id: "owner:second",
      title: "Second bounded work item",
    });
    await page.route("**/api/v1/now*", (route) => route.fulfill({ json: model }));
    await page.goto("/now");
    const first = page.getByRole("button", { name: "Material drop is not confirmed" });
    const second = page.getByRole("button", { name: "Second bounded work item" });
    await expect(first).toBeVisible();
    await first.focus();
    await page.keyboard.press("j");
    await expect(second).toBeFocused();
    const inspector = page.getByRole("complementary", { name: "Selected item" });
    await expect(
      inspector.getByRole("heading", { name: "Second bounded work item" }),
    ).toBeVisible();
    await expect(inspector.getByRole("link", { name: "Work record" })).toHaveAttribute(
      "href",
      "/owner",
    );
    await expect(page.getByRole("dialog")).toBeHidden();
    await inspector.getByRole("button", { name: "Close details" }).click();
    await expect(second).toBeFocused();
    await page.keyboard.press("k");
    await expect(first).toBeFocused();
    await expect(
      inspector.getByRole("heading", { name: "Material drop is not confirmed" }),
    ).toBeVisible();
    await page.screenshot({
      path: `${shotDir}/now-inspector-${testInfo.project.name}.png`,
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Keep jobs moving 0" }).click();
    await expect(first).toBeHidden();
    await expect(page.getByRole("complementary", { name: "Work overview" })).toBeVisible();
    await expect(page.getByText("No items in this loaded section.")).toBeVisible();
    await expect(page.getByText(nowResponse.ui.sync_label)).toBeVisible();
    await page.getByRole("button", { name: "All work 2" }).click();
    await expect(first).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`phone details preserve focus, records and geometry in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile-chromium", "390px phone drawer path");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.route("**/api/v1/now*", (route) => route.fulfill({ json: nowResponse }));
      await page.goto("/now");
      const row = page.getByRole("button", { name: "Material drop is not confirmed" });
      await expect(row).toBeVisible();
      const rootSize = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        rect: document.documentElement.getBoundingClientRect().width,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(rootSize.scroll).toBeLessThanOrEqual(Math.min(rootSize.client, rootSize.rect));
      await page.screenshot({ path: `${shotDir}/now-phone-${theme}.png` });
      await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const visibleRow = await row.evaluate((element) => {
        const rect = element.closest(".now-row")!.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
      });
      expect(visibleRow.top).toBeGreaterThanOrEqual(80);
      expect(visibleRow.bottom).toBeLessThanOrEqual(visibleRow.viewport - 80);
      await page.screenshot({ path: `${shotDir}/now-phone-work-${theme}.png` });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await row.click();
      const drawer = page.getByRole("dialog", { name: "Material drop is not confirmed" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Open item" })).toHaveAttribute(
        "href",
        "/owner",
      );
      await expect(drawer.getByRole("link", { name: "Work record" })).toHaveAttribute(
        "href",
        "/owner",
      );
      const dialogSize = await drawer.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      expect(dialogSize.scroll).toBeLessThanOrEqual(dialogSize.client);
      await expectTouchTarget(drawer.getByRole("button", { name: "Close" }), {
        name: "Close drawer",
      });
      await page.screenshot({ path: `${shotDir}/now-drawer-${theme}.png` });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(row).toBeFocused();
      await row.click();
      await drawer.getByRole("button", { name: "Close" }).click();
      await expect(drawer).toBeHidden();
      await expect(row).toBeFocused();
    });
  }
  test("forgets a removed phone selection before the work returns", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "native phone focus path");
    let response: NowResponse = structuredClone(nowResponse);
    response.ui.sections[0]!.cards[0]!.action = {
      id: "jobs:retry",
      kind: "refresh",
      href: null,
      label: "Try again",
      reason: "The jobs list did not load.",
      citation_ids: [],
    };
    await page.route("**/api/v1/now*", (route) => route.fulfill({ json: response }));
    await page.goto("/now");
    const row = page.getByRole("button", { name: "Material drop is not confirmed" });
    await row.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    response = { ...response, ui: { ...response.ui, sections: [] } };
    await Promise.all([
      page.waitForResponse("**/api/v1/now*"),
      page.getByRole("dialog").getByRole("button", { name: "Try again" }).click(),
    ]);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "All work 0" })).toBeFocused();
    response = structuredClone(nowResponse);
    await Promise.all([
      page.waitForResponse("**/api/v1/now*"),
      page.getByRole("button", { name: "Check all lists again" }).click(),
    ]);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("shows a failed card retry inside the open phone drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "native phone alert path");
    const response: NowResponse = structuredClone(nowResponse);
    response.ui.sections[0]!.cards[0]!.action = {
      id: "jobs:retry",
      kind: "refresh",
      href: null,
      label: "Try again",
      reason: "The jobs list did not load.",
      citation_ids: [],
    };
    let count = 0;
    await page.route("**/api/v1/now*", (route) =>
      ++count === 1
        ? route.fulfill({ json: response })
        : route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } }),
    );
    await page.goto("/now");
    await page.getByRole("button", { name: "Material drop is not confirmed" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Try again" }).click();
    await expect(drawer.getByRole("alert")).toContainText("The last saved list is still shown");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Work record" })).toHaveAttribute(
      "href",
      "/owner",
    );
  });
});
