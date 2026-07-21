import { expect, test } from "@playwright/test";

const estimatorMode = process.env.ACCEPTANCE_MODE === "estimator";
const jobId = "JOB-ESTIMATOR-ACCEPTANCE";

test.describe("Estimator Workbench acceptance", () => {
  test.skip(!estimatorMode, "requires ACCEPTANCE_MODE=estimator");

  test("renders a browser-safe roof graph and keyboard-selects a facet", async ({ page }) => {
    const workbenchResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return (
        requestUrl.pathname === `/api/v1/estimator/jobs/${jobId}` &&
        response.request().method() === "GET"
      );
    });

    await page.goto(`/estimator/jobs/${jobId}`);
    await expect(page.getByRole("heading", { name: "Measurement workbench" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roof graph evidence" })).toBeVisible();

    const northFacet = page.getByRole("button", {
      name: "Select facet North plane, Approved",
    });
    await northFacet.focus();
    await expect(northFacet).toBeFocused();
    await page.keyboard.press(" ");
    await expect(northFacet).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Selected facet: North plane")).toBeVisible();

    const payload = await (await workbenchResponse).json();
    expect(JSON.stringify(payload)).not.toMatch(/raw_?key|hash|model_?(?:url|uri)/i);
    await expect(page.locator("main")).not.toContainText(/raw_?key|hash|model_?(?:url|uri)/i);
  });
});
