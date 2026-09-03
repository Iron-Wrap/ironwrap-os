import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { detailResponse, listResponse, serviceCase } from "../src/service/service-fixtures";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

async function expectNoSideScroll(page: Page) {
  const size = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(size.page).toBeLessThanOrEqual(size.view + 1);
}

test.describe("Service calls acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps each service step clear, safe, and usable at every viewport", async ({
    page,
  }, testInfo) => {
    const openCase = serviceCase();
    await page.route("**/api/v1/service-cases/svc_case_0001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      }),
    );
    await page.route("**/api/v1/service-cases", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(listResponse([openCase])),
      }),
    );

    await page.goto("/service");

    await expect(page.getByRole("heading", { name: "Service calls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open calls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Save a new call" })).toBeVisible();
    await expect(page.getByText("svc_case_0001", { exact: true })).toHaveCount(0);

    const callLink = page.getByRole("link", { name: /interior water stain/i });
    await expect(callLink).toHaveAttribute("href", "/service/svc_case_0001");
    await expectTouchTarget(callLink, { name: "service call link", axis: "height" });
    await expectNoSideScroll(page);
    await page.screenshot({ path: `${shotDir}/service-calls-${testInfo.project.name}.png` });

    await page.getByLabel("Need level").selectOption("emergency");
    await page.getByLabel("Call back in (minutes)").fill("241");
    await expect(page.getByText("An emergency cannot wait that long")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save call" })).toBeDisabled();
    await expectNoSideScroll(page);

    await callLink.click();

    await expect(page.getByRole("heading", { name: /interior water stain/i })).toBeVisible();
    await expect(page.getByRole("form", { name: "Check this call" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cost check" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Call history" })).toBeVisible();
    await expect(page.getByText(/Call ID svc_case_0001/)).toBeHidden();

    const proof = page.getByLabel("Proof code");
    await expect(proof).toHaveAttribute("pattern", "[0-9a-f]{64}");
    await expect(proof).toHaveAttribute("minlength", "64");
    await expect(proof).toHaveAttribute("maxlength", "64");
    await expect(page.getByRole("button", { name: "Save check" })).toBeDisabled();
    await expectTouchTarget(page.getByRole("link", { name: "Back to Service calls" }), {
      name: "Back to Service calls",
      axis: "height",
    });

    await expectNoSideScroll(page);
    await page.screenshot({ path: `${shotDir}/service-case-${testInfo.project.name}.png` });
  });
});
