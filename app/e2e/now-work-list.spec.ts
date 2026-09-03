import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import type { NowResponse } from "../src/now/now-contracts";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

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
        summary: "No job needs a check.",
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
    await page.route("**/api/v1/now", (route) =>
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
});
