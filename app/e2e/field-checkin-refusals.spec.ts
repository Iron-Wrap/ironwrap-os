import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * What a crew member sees when the server cannot take a check-in (ELEC-211).
 *
 * Two states, both on the phone the work is done from:
 *
 * 1. The job is scheduled but production has not issued a work plan yet — the default state right
 *    after scheduling. The server refuses evidence in that state
 *    (`workers-bus/migrations/0044_work_package_evidence_slots.sql`), so the surface does not offer
 *    photo capture and says why, instead of accepting files it can never send.
 * 2. The server refuses a submission terminally. The saved item must leave "Waiting" and read as a
 *    stopped item with a next step, never as an upload still looking for signal.
 */

const PHONE = { width: 390, height: 844 };
const fieldMode = (process.env.ACCEPTANCE_MODE ?? "field") === "field";

test.describe("Check-in refusals on the crew phone", () => {
  test.skip(!fieldMode, "requires ACCEPTANCE_MODE=field (the default)");

  test.beforeEach(async ({ page, request, baseURL }) => {
    expect((await request.post(`${baseURL}/__acceptance__/reset`)).ok()).toBe(true);
    await page.setViewportSize(PHONE);
    await seedPairedFieldDevice(page);
  });

  test("offers no photo capture before production issues a work plan, and says why", async ({
    page,
  }, testInfo) => {
    await routeJobWithoutWorkPackage(page);
    await page.goto("/check-in/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Say what is happening" })).toBeVisible();
    await expect(
      page.getByText("Photos can be attached once production issues a work plan."),
    ).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    await testInfo.attach("checkin-no-work-plan-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: "test-results/evidence/checkin-no-work-plan-390px.png",
      }),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Report a blocker" }).click();
    await expect(
      page.getByText(
        "This report sends as text. Photos can be attached once production issues a work plan.",
      ),
    ).toBeVisible();
    // A crew member reads this on a roof: nothing may spill sideways off the phone.
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(PHONE.width);

    await testInfo.attach("checkin-blocker-no-photos-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: "test-results/evidence/checkin-blocker-no-photos-390px.png",
      }),
      contentType: "image/png",
    });
  });

  test("moves a terminally refused check-in out of Waiting and into needs-attention", async ({
    page,
  }, testInfo) => {
    await routeJobWithoutWorkPackage(page);
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE/check-ins", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          code: "field_action_evidence_requires_work_package",
          message: "Evidence requires a released work package.",
        }),
      }),
    );
    await page.goto("/check-in/JOB-ACCEPTANCE");

    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Report a blocker" }).click();
    await page
      .getByLabel("What must happen next?")
      .fill("Crew is on site and cannot start: no work plan has been issued.");
    await page.getByRole("button", { name: "Save on device" }).click();

    await expect(page.getByRole("heading", { name: "Check-in needs a check" })).toBeVisible();
    // The badge on the saved item itself, not the shell's outbox summary line.
    await expect(page.getByText("Needs a check", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Waiting", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Production has not issued a work plan for this job, so files cannot be filed to it.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Ask production to issue the work plan/)).toBeVisible();

    await testInfo.attach("checkin-needs-attention-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: "test-results/evidence/checkin-needs-attention-390px.png",
      }),
      contentType: "image/png",
    });
    // The panel on its own: the fixed bottom rail crosses the full-page capture.
    await testInfo.attach("checkin-needs-attention-panel-390px.png", {
      body: await page.getByTestId("checkin-saved").screenshot({
        path: "test-results/evidence/checkin-needs-attention-panel-390px.png",
      }),
      contentType: "image/png",
    });

    // The same item is waiting on Today, with the same next step and no retry that cannot work.
    await page.goto("/today");
    const savedWork = page.locator("#saved-work");
    await expect(
      savedWork.getByRole("heading", { name: "One saved item needs review" }),
    ).toBeVisible();
    await expect(savedWork.getByText(/Ask production to issue the work plan/)).toBeVisible();
    await expect(savedWork.getByRole("button", { name: "Try again" })).toHaveCount(0);

    await testInfo.attach("saved-work-needs-attention-390px.png", {
      body: await savedWork.screenshot({
        path: "test-results/evidence/saved-work-needs-attention-390px.png",
      }),
      contentType: "image/png",
    });
  });
});

/**
 * The fixture job carries a released work package. Strip it from every read of that job so the
 * app sees the state a freshly scheduled job is actually in, without teaching the shared
 * acceptance fixture a second job.
 */
async function routeJobWithoutWorkPackage(page: Page) {
  await page.route("**/api/v1/jobs/JOB-ACCEPTANCE", async (route: Route) => {
    const response = await route.fetch();
    const model = await response.json();
    model.packet.work_package = null;
    model.allowed_actions = ["field.checkin.create"];
    await route.fulfill({ response, json: model });
  });
}

async function seedPairedFieldDevice(page: Page, proof = "a".repeat(43)) {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
  await page.evaluate(async (deviceProof) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ironwrap-os");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put({
          key: "field-device-secret-v1",
          value: { value: deviceProof, createdAt: Date.now() },
          updatedAt: Date.now(),
        });
        transaction.addEventListener("complete", () => resolve(), { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, proof);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
}
