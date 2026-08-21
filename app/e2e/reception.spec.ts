import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { newoOperationsFixture } from "../src/newo/newo-operations-test-fixture";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

test.describe("Reception acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows call problems without unsafe actions or a wide table", async ({ page }, testInfo) => {
    await page.route("**/api/v1/newo/operations", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(newoOperationsFixture()),
      }),
    );

    await page.goto("/newo");

    await expect(page.getByRole("heading", { name: "Reception", exact: true })).toBeVisible();
    await expect(page.getByText("Check", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Calls to check" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Call reports missing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Calls not passed on" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Booking requests" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Latest calls" })).toBeVisible();
    await expect(page.locator("main table")).toHaveCount(0);

    const rawCallIds = page.getByText(/Call ID session-1/);
    expect(await rawCallIds.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await rawCallIds.count()); index += 1) {
      await expect(rawCallIds.nth(index)).toBeHidden();
    }

    await expect(
      page.getByRole("button", { name: /send|book|approve|delete|run|fix/i }),
    ).toHaveCount(0);
    const refresh = page.getByRole("button", { name: "Refresh Reception" });
    await expect(refresh).toBeVisible();
    expect((await refresh.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    const size = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(size.page).toBeLessThanOrEqual(size.view + 1);
    await page.screenshot({ path: `${shotDir}/reception-${testInfo.project.name}.png` });

    await page.getByText("System details").first().click();
    await expect(rawCallIds.first()).toBeVisible();
    await page.getByRole("heading", { name: "Latest calls" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shotDir}/reception-latest-${testInfo.project.name}.png` });
  });
});
