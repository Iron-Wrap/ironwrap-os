import { expect, test } from "@playwright/test";

const estimatorMode = process.env.ACCEPTANCE_MODE === "estimator";
const jobId = "JOB-ESTIMATOR-ACCEPTANCE";

test.describe("Estimator Workbench acceptance", () => {
  test.skip(!estimatorMode, "requires ACCEPTANCE_MODE=estimator");

  test("keeps each job's D5 identity separate and reads older missing identity honestly", async ({
    page,
  }) => {
    const fixtureResponse = await page.request.get(`/api/v1/estimator/jobs/${jobId}`);
    expect(fixtureResponse.ok()).toBe(true);
    const fixture = await fixtureResponse.json();
    const jobs = [
      {
        id: jobId,
        customer_display_name: "Synthetic Cedar Household",
        address: "Unit 4, 118 Example Way NW, Edmonton, AB",
        job_number: "IW-SYNTHETIC-101",
        label: "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
      },
      {
        id: "JOB-SYNTHETIC-OTHER",
        customer_display_name: "Synthetic Juniper Household",
        address: "216 Example Lane NW, Edmonton, AB",
        job_number: "IW-SYNTHETIC-102",
        label: "Synthetic Juniper Household · 216 Example Lane NW · Job IW-SYNTHETIC-102",
      },
      {
        id: "JOB-SYNTHETIC-OLDER",
        customer_display_name: undefined,
        address: undefined,
        job_number: null,
        label: "Job details unavailable",
      },
    ];
    await page.route("**/api/v1/estimator/jobs/*", async (route) => {
      expect(new URL(route.request().url()).searchParams.getAll("include_job_identity")).toEqual([
        "1",
      ]);
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const selected = jobs.find((job) => job.id === id)!;
      await route.fulfill({
        json: {
          ...fixture,
          job: {
            ...fixture.job,
            id,
            roof_job_id: id,
            job_number: selected.job_number,
            customer_display_name: selected.customer_display_name,
            address: selected.address,
          },
        },
      });
    });
    for (const job of jobs) {
      await page.goto(`/estimator/jobs/${job.id}`);
      await expect(page.getByRole("heading", { name: "Roof and quote review" })).toBeVisible();
      await expect(page.getByLabel("Job identity")).toHaveText(job.label);
      await expect(page.getByLabel("Job identity")).not.toContainText(job.id);
      await expect(page.getByRole("region", { name: "Next step" }).getByRole("link")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });

  for (const [state, action, target] of [
    ["blocked", "See blocked items", "proposal-readiness-heading"],
    ["review_required", "See what needs review", "proposal-readiness-heading"],
    ["ready", "Open proposal details", "proposal-heading"],
    ["unavailable", "Open saved details", "review-workspace-heading"],
  ] as const) {
    test(`next step opens the saved ${state} evidence by keyboard`, async ({ page }, testInfo) => {
      await page.route(
        (url) => url.pathname === `/api/v1/estimator/jobs/${jobId}`,
        async (route) => {
          expect(
            new URL(route.request().url()).searchParams.getAll("include_job_identity"),
          ).toEqual(["1"]);
          const response = await route.fetch();
          const model = await response.json();
          model.job = {
            ...model.job,
            customer_display_name: "Synthetic Cedar Household",
            address: "Unit 4, 118 Example Way NW, Edmonton, AB",
            job_number: "IW-SYNTHETIC-101",
          };
          model.proposal_readiness.state = state;
          if (state === "ready") model.proposal_readiness.reasons = [];
          await route.fulfill({ response, json: model });
        },
      );
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
