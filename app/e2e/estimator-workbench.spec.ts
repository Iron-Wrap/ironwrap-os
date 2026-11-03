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
      await expect(page).toHaveURL(
        new RegExp(`\\?read=${state === "unavailable" ? "saved" : "proposal"}#${target}$`),
      );
      if (state !== "unavailable") {
        for (const field of ["Prepared", "Approved", "Signed", "Assumptions", "Exclusions"]) {
          await expect(page.getByText(field, { exact: true })).toBeVisible();
        }
      } else {
        await expect(
          page.getByRole("heading", { name: "Saved job details", exact: true }),
        ).toBeVisible();
        await expect(page.locator("summary").filter({ hasText: "Roof details" })).toBeVisible();
        await expect(
          page.locator("summary").filter({ hasText: "Materials and insurance" }),
        ).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath("next-step-open.png") });
      await page.goBack();
      await expect(page).toHaveURL(`/estimator/jobs/${jobId}`);
      await expect(page.locator("#next-safe-step-heading")).toBeFocused();
      await expect(link).toBeVisible();
      await page.goForward();
      await expect(page.locator(`#${target}`)).toBeFocused();
      const back = page.getByRole("link", { name: "Back to roof and quote review" });
      await back.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#next-safe-step-heading")).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`#next-safe-step-heading$`));
      expect(writes).toEqual([]);
    });
  }

  test("opens both read destinations directly and preserves their job context", async ({
    page,
  }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
        writes.push(request.method());
      }
    });
    await page.goto(`/estimator/jobs/${jobId}?read=proposal#proposal-heading`);
    await expect(page.getByRole("heading", { name: "Proposal", exact: true })).toBeFocused();
    await expect(page.getByText(/Ref: IW-EST-1001/)).toBeVisible();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(page.getByText("Signed", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Saved job details", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${jobId}\\?read=saved#review-workspace-heading$`));
    await expect(page.locator("#review-workspace-heading")).toBeFocused();
    await page.locator("summary").filter({ hasText: "Roof details" }).click();
    await expect(page.getByRole("heading", { name: "Roof shape drawing" })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Materials and insurance" }).click();
    await expect(page.getByRole("heading", { name: "Materials", exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });

  for (const view of ["proposal", "saved"]) {
    test(`refuses a different job response at a direct ${view} link`, async ({ page }) => {
      await page.route(`**/api/v1/estimator/jobs/${jobId}`, async (route) => {
        const response = await route.fetch();
        const model = await response.json();
        model.job.id = "JOB-UNRELATED-SYNTHETIC";
        await route.fulfill({ response, json: model });
      });
      await page.goto(`/estimator/jobs/${jobId}?read=${view}`);
      await expect(page.getByText("These details belong to another job")).toBeVisible();
      await expect(page.getByText(/Ref: IW-EST-1001/)).toHaveCount(0);
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
