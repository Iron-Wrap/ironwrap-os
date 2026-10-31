import { expect, test } from "@playwright/test";

const estimatorMode = process.env.ACCEPTANCE_MODE === "estimator";
const jobId = "JOB-ESTIMATOR-ACCEPTANCE";

test.describe("Estimator Workbench acceptance", () => {
  test.skip(!estimatorMode, "requires ACCEPTANCE_MODE=estimator");

  for (const [state, action, target] of [
    ["blocked", "See blocked items", "proposal-readiness-heading"],
    ["review_required", "See what needs review", "proposal-readiness-heading"],
    ["ready", "Open proposal details", "proposal-heading"],
    ["unavailable", "Open saved details", "review-workspace-heading"],
  ] as const) {
    test(`next step opens the saved ${state} evidence by keyboard`, async ({ page }, testInfo) => {
      await page.route(`**/api/v1/estimator/jobs/${jobId}`, async (route) => {
        const response = await route.fetch();
        const model = await response.json();
        model.proposal_readiness.state = state;
        if (state === "ready") model.proposal_readiness.reasons = [];
        await route.fulfill({ response, json: model });
      });
      await page.goto(`/estimator/jobs/${jobId}`);
      const nextStep = page.getByRole("region", { name: "Next step" });
      const link = nextStep.getByRole("link", { name: action });
      await expect(link).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("next-step-rest.png") });

      const writes: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
      });
      await link.focus();
      await page.keyboard.press("Enter");
      const heading = page.locator(`#${target}`);
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport();
      await expect(page).toHaveURL(new RegExp(`#${target}$`));
      if (state !== "unavailable") {
        await expect(page.locator('details[aria-labelledby="proposal-heading"]')).toHaveAttribute(
          "open",
        );
      }
      await page.screenshot({ path: testInfo.outputPath("next-step-open.png") });
      expect(writes).toEqual([]);
    });
  }

  test("renders a browser-safe roof graph and keyboard-selects a facet", async ({ page }) => {
    const workbenchResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return (
        requestUrl.pathname === `/api/v1/estimator/jobs/${jobId}` &&
        response.request().method() === "GET"
      );
    });

    await page.goto(`/estimator/jobs/${jobId}`);
    await expect(page.getByRole("heading", { name: "Roof and quote review" })).toBeVisible();
    const roofSection = page.locator("summary").filter({ hasText: "Roof details" });
    await expect(roofSection.getByText("Show details")).toBeVisible();
    await roofSection.click();
    await expect(roofSection.getByText("Hide details")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roof shape drawing" })).toBeVisible();

    const northFacet = page.getByRole("button", {
      name: "Select roof face North plane, Approved",
    });
    await northFacet.focus();
    await expect(northFacet).toBeFocused();
    await page.keyboard.press(" ");
    await expect(northFacet).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Selected roof face: North plane")).toBeVisible();

    const payload = await (await workbenchResponse).json();
    expect(JSON.stringify(payload)).not.toMatch(/raw_?key|hash|model_?(?:url|uri)/i);
    await expect(page.locator("main")).not.toContainText(/raw_?key|hash|model_?(?:url|uri)/i);
  });
});
