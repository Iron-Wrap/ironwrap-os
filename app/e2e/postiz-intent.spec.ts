import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";

import { postizIntentFixture } from "../src/postiz/postiz-test-fixture";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const intentId = "11111111-1111-4111-8111-111111111111";

test.describe("Marketing post acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the marketing post clear and system IDs out of the first view", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/postiz/intents/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(postizIntentFixture()),
      }),
    );

    await page.goto(`/marketing/postiz/${intentId}`);

    await expect(
      page.getByRole("heading", { name: "Spring roof inspection reminder" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve post" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn down" })).toBeVisible();
    await expect(page.getByText("provider_detail_not_exposed")).toHaveCount(0);
    await expect(page.getByText("marketing.social.publish.reviewed")).toBeHidden();
    await expect(page.getByText("campaign-brief:001", { exact: true })).toBeHidden();
    await expect(page.getByText("evidence:campaign-brief:001")).toBeHidden();

    await assertNoFrappeDesk(page);
    await page.screenshot({
      path: `${shotDir}/marketing-post-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("marketing.social.publish.reviewed")).toBeVisible();

    for (const name of ["Load again", "Approve post", "Turn down", "Check saved state"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  });
});
