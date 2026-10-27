import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * What a crew member sees on a job production has not planned yet (ELEC-211, ELEC-213).
 *
 * Two states, both on the phone the work is done from:
 *
 * 1. The job is scheduled but has no work plan — the default state right after scheduling, and
 *    where most field photos are taken. The server accepts a plain check-in with media there: only
 *    a payload that *asserts* a Work Package binding needs a released plan
 *    (`workers-bus/src/field-actions.ts` `carriesEvidenceBinding`), and `0044`'s trigger is a no-op
 *    when none of its columns are set. So the camera is offered and the photo actually sends.
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

  test("offers photo and voice capture before production issues a work plan, and sends it", async ({
    page,
  }, testInfo) => {
    await routeJobWithoutWorkPackage(page);
    await page.goto("/check-in/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Capture what you see" })).toBeVisible();
    await expect(page.locator('input[type="file"][accept*="image"]')).toHaveCount(1);
    await expect(page.locator('input[type="file"][accept*="audio"]')).toHaveCount(1);
    const progress = page.getByRole("list", { name: "Check-in progress, step 1 of 3" });
    await expect(progress.locator('[aria-current="step"]')).toHaveText("1Files");
    await expect(
      page.getByText("Photos can be attached once production issues a work plan."),
    ).toHaveCount(0);
    // A crew member reads this on a roof: nothing may spill sideways off the phone.
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(PHONE.width);

    await testInfo.attach("checkin-no-work-plan-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: "test-results/evidence/checkin-no-work-plan-390px.png",
      }),
      contentType: "image/png",
    });

    await page.setInputFiles('input[type="file"][accept*="image"]', {
      name: "north-slope.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    });
    await expect(page.getByText("north-slope.jpg")).toBeVisible();

    await testInfo.attach("checkin-no-work-plan-photo-selected-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: "test-results/evidence/checkin-no-work-plan-photo-selected-390px.png",
      }),
      contentType: "image/png",
    });

    // The acceptance server applies the same untyped/typed split as the Worker, so a green send
    // here is proof the photo is accepted rather than refused on a job with no plan.
    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Save on device" }).click();
    await expect(page.getByRole("heading", { name: "Check-in saved" })).toBeVisible();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Check-in needs a check" })).toHaveCount(0);

    await testInfo.attach("checkin-no-work-plan-sent-390px.png", {
      body: await page.getByTestId("checkin-saved").screenshot({
        path: "test-results/evidence/checkin-no-work-plan-sent-390px.png",
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
        "Production has not issued a job plan for this job, so files cannot be filed to it.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Ask production to issue the job plan/)).toBeVisible();

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
    await expect(savedWork.getByText(/Ask production to issue the job plan/)).toBeVisible();
    await expect(savedWork.getByRole("button", { name: "Try again" })).toHaveCount(0);

    await testInfo.attach("saved-work-needs-attention-390px.png", {
      body: await savedWork.screenshot({
        path: "test-results/evidence/saved-work-needs-attention-390px.png",
      }),
      contentType: "image/png",
    });
  });

  test("keeps an unconfirmed office answer for review without claiming sent or sending again", async ({
    page,
  }, testInfo) => {
    await routeJobWithoutWorkPackage(page);
    let sends = 0;
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE/check-ins", async (route) => {
      sends += 1;
      const response = await route.fetch();
      const answer = await response.json();
      answer.device_action_id = "different-saved-item";
      await route.fulfill({ response, json: answer });
    });
    await page.goto("/check-in/JOB-ACCEPTANCE");
    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Report a blocker" }).click();
    await page.getByLabel("What must happen next?").fill("The office needs to check the delivery.");
    await page.getByRole("button", { name: "Save on device" }).click();

    const receipt = page.getByTestId("checkin-saved");
    await expect(receipt.getByText("Needs a check", { exact: true })).toBeVisible();
    await expect(receipt).toContainText("could not confirm the office has this exact item");
    await expect(receipt).toContainText(
      "Do not save it again. Call the office and ask whether it arrived.",
    );
    await expect(receipt.getByText("Sent", { exact: true })).toHaveCount(0);
    await expect(receipt).not.toContainText(/not sent|did not send/i);
    await expect(receipt).toContainText("Saved on this phone");
    await expect(receipt).toContainText("This check-in is not confirmed.");
    await receipt
      .getByRole("alert")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await testInfo.attach("unconfirmed-checkin-phone.png", {
      body: await page.screenshot({ path: testInfo.outputPath("unconfirmed-checkin-phone.png") }),
      contentType: "image/png",
    });

    await page.goto("/today");
    await page.reload();
    const savedWork = page.locator("#saved-work");
    await expect(savedWork).toContainText("could not confirm the office has this exact item");
    await expect(savedWork.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(savedWork.getByText("Sent", { exact: true })).toHaveCount(0);
    expect(sends).toBe(1);
    const keptAction = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ironwrap-os");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<{ state: string; lastError?: { code: string } }[]>(
          (resolve, reject) => {
            const request = database
              .transaction("outbox_actions")
              .objectStore("outbox_actions")
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          },
        );
      } finally {
        database.close();
      }
    });
    expect(keptAction).toMatchObject([
      { state: "needs_attention", lastError: { code: "verification_mismatch" } },
    ]);
    await savedWork
      .getByText(
        "The office answered, but this phone could not confirm the office has this exact item.",
      )
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await testInfo.attach("unconfirmed-saved-work-phone.png", {
      body: await page.screenshot({
        path: testInfo.outputPath("unconfirmed-saved-work-phone.png"),
      }),
      contentType: "image/png",
    });
  });

  test("opens the camera from the job in one app action and keeps the sent receipt across readback", async ({
    page,
  }, testInfo) => {
    let reads = 0;
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE", async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      model.packet.work_package = null;
      model.allowed_actions = ["field.checkin.create"];
      model.read_model_generated_at = `2026-10-02T12:00:${String(++reads).padStart(2, "0")}.000Z`;
      await route.fulfill({ response, json: model });
    });
    await page.goto("/jobs/JOB-ACCEPTANCE");
    const camera = page.getByLabel("Take photo for this job");
    await expect(camera).toHaveAttribute("capture", "environment");
    await expect(camera).not.toHaveAttribute("multiple", "");
    const picker = page.waitForEvent("filechooser");
    await page.getByText("Take photo", { exact: true }).click();
    await (
      await picker
    ).setFiles({
      name: "direct-job-photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });
    await expect(page.getByRole("heading", { name: "Add job details" })).toBeVisible();
    await expect(page.getByText("direct-job-photo.jpg")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to review" })).toHaveCount(0);
    const save = page.getByRole("button", { name: "Save on device" });
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await save.click();
    await expect(page.getByRole("heading", { name: "Check-in saved" })).toBeVisible();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("The server got this check-in.")).toBeVisible();
    await testInfo.attach("direct-photo-receipt-390px.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Return to job" }).click();
    await expect(page.getByText("Take photo", { exact: true })).toBeVisible();
  });

  test("turns an unconfirmed receipt into the office's confirmation once a person settles it", async ({
    page,
  }) => {
    await routeJobWithoutWorkPackage(page);
    // The office records the check-in but answers about another item, so this phone cannot
    // confirm it holds this exact one.
    let deviceActionId: string | undefined;
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE/check-ins", async (route) => {
      deviceActionId = route.request().headers()["x-device-action-id"];
      const response = await route.fetch();
      const answer = await response.json();
      await route.fulfill({ response, json: { ...answer, device_action_id: "another-item" } });
    });
    let officeAnswered = false;
    await page.route("**/api/v1/field-item-resolutions?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          resolutions: officeAnswered
            ? [
                {
                  resolution_id: `fir_${"1".repeat(64)}`,
                  device_action_id: deviceActionId,
                  item_kind: "field_checkin",
                  payload_sha256: "a".repeat(64),
                  resolution: "arrived",
                  linked_record: { type: "field_action", id: deviceActionId },
                  resolved_at: new Date().toISOString(),
                },
              ]
            : [],
        }),
      }),
    );
    await page.goto("/check-in/JOB-ACCEPTANCE");
    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Report a blocker" }).click();
    await page.getByLabel("What must happen next?").fill("Ladder access blocked by a parked van.");
    await page.getByRole("button", { name: "Save on device" }).click();
    const receipt = page.getByTestId("checkin-saved");
    await expect(receipt.getByText("Needs a check", { exact: true })).toBeVisible();

    // A person in the office settles it; the next sync (here: the phone coming online) reads it.
    officeAnswered = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(receipt.getByText("The office confirmed it has this.")).toBeVisible();
    await expect(receipt.getByText("Sent", { exact: true })).toBeVisible();
    await expect(receipt.getByText("Needs a check", { exact: true })).toHaveCount(0);

    // Today says why the item left the red list, until the person has read it.
    await page.goto("/today");
    const settled = page.getByRole("region", { name: "The office has your saved item" });
    await expect(settled.getByText("The office confirmed it has this.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "One saved item needs review" })).toHaveCount(0);
    await settled.getByRole("button", { name: "Got it" }).click();
    await expect(settled).toHaveCount(0);
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
