import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";
import { settleAnimations } from "./settle";

/**
 * The administrator-configured part of a job, on the phone the work is actually done from.
 *
 * These run against the field acceptance fixture, whose job carries two field-key namespaces
 * (roofing, gutters) plus one un-namespaced field, so a single pass covers the grouped
 * multi-service card, the unfilled field, and the mobile layout.
 */

const PHONE = { width: 390, height: 844 };

test.describe("Schema-driven job card", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post("/__acceptance/schema-card/reset");
    await seedPairedFieldDevice(page);
  });

  test("renders every configured field on a 390px phone, grouped by service type", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Configured fields" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roofing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gutters" })).toBeVisible();

    await expect(page.getByTestId("schema-field-roofing.deck_condition")).toHaveText(
      "Sound, two soft sheets",
    );
    await expect(page.getByTestId("schema-field-roofing.underlayment")).toHaveText("Synthetic");
    await expect(page.getByTestId("schema-field-gutters.linear_feet")).toHaveText("142");
    await expect(page.getByTestId("schema-field-gutters.downspouts")).toHaveText("6");

    // A configured field with nothing in it stays visible and says so, rather than vanishing and
    // leaving the crew unsure whether it was ever asked for.
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("Not recorded");

    // Nothing may overflow the phone: a value that spills sideways is a card the crew cannot read.
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(PHONE.width);

    await testInfo.attach("schema-job-card-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-390px.png`,
      }),
      contentType: "image/png",
    });

    await settleAnimations(page);
    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("keeps the card readable offline once the crew has opened the job", async ({
    context,
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByTestId("schema-field-roofing.underlayment")).toHaveText("Synthetic");
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Configured fields" })).toBeVisible();
    await expect(page.getByTestId("schema-field-roofing.underlayment")).toHaveText("Synthetic");
    await expect(page.getByTestId("schema-field-gutters.linear_feet")).toHaveText("142");
    // Scoped to the card's own section: the documents section below it renders its own offline
    // notice, and an unscoped page-wide text match resolves to both.
    await expect(page.getByTestId("schema-card-offline-notice")).toHaveText(
      /Showing the copy saved on this device/i,
    );

    await testInfo.attach("schema-job-card-offline-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-offline-390px.png`,
      }),
      contentType: "image/png",
    });

    await context.setOffline(false);
  });

  test("does not offer the crew a way into owner configuration", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Configured fields" })).toBeVisible();
    await expect(page.getByRole("link", { name: /customize fields/i })).toHaveCount(0);
  });
});

/**
 * Filling the card in, which is what makes it a delivered feature rather than a configuration
 * screen with extra steps (ELEC-193). The fixture's crew role may write four of these fields and
 * not the fifth, so one pass covers both the affordance and its deliberate absence.
 */
test.describe("Writing back to the schema-driven job card", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post("/__acceptance/schema-card/reset");
    await seedPairedFieldDevice(page);
    await page.setViewportSize(PHONE);
  });

  test("records a value the crew enters, and offers no control on a field they may not write", async ({
    page,
  }, testInfo) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("Not recorded");

    // The office-owned field is readable and carries no edit control at all — not a disabled one,
    // and not one that would 403 on press.
    await expect(page.getByTestId("schema-field-office_notes")).toHaveText("Invoice on completion");
    await expect(page.getByTestId("schema-field-edit-office_notes")).toHaveCount(0);

    await page.getByTestId("schema-field-edit-permit_number").click();
    // Every target the crew has to hit stays thumb-sized on a 390px phone.
    for (const testId of ["schema-field-input-permit_number", "schema-field-save-permit_number"]) {
      await expectTouchTarget(page.getByTestId(testId), { name: testId, axis: "height" });
    }
    await page.getByTestId("schema-field-input-permit_number").fill("CAL-2026-8891");

    await testInfo.attach("schema-job-card-editing-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-editing-390px.png`,
      }),
      contentType: "image/png",
    });

    await page.getByTestId("schema-field-save-permit_number").click();
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("CAL-2026-8891");

    // It is the record that holds it now, not the tab: a reload reads it back from the server.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("CAL-2026-8891");

    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(PHONE.width);

    await testInfo.attach("schema-job-card-written-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-written-390px.png`,
      }),
      contentType: "image/png",
    });

    await settleAnimations(page);
    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("says what the administrator's own rule wants when the server refuses the value", async ({
    page,
  }, testInfo) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");

    // The fixture field carries a 1..400 range, so 900 is refused by the server, not by the client.
    await page.getByTestId("schema-field-edit-gutters.linear_feet").click();
    await page.getByTestId("schema-field-input-gutters.linear_feet").fill("900");
    await page.getByTestId("schema-field-save-gutters.linear_feet").click();

    await expect(page.getByRole("alert")).toHaveText("Enter a number between 1 and 400.");
    // Nothing was discarded: the entry is still there to correct.
    await expect(page.getByTestId("schema-field-input-gutters.linear_feet")).toHaveValue("900");

    await testInfo.attach("schema-job-card-refusal-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-refusal-390px.png`,
      }),
      contentType: "image/png",
    });
  });

  test("makes a conflicting change to an evidence field state what it corrects, keeping both", async ({
    page,
  }, testInfo) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await page.getByTestId("schema-field-edit-roofing.deck_condition").click();
    await page.getByTestId("schema-field-input-roofing.deck_condition").fill("Four soft sheets");

    // Someone in the office writes the same field while the crew member is still typing.
    const elsewhere = await page.request.post(
      "/api/v1/schema-fields/job/roof-job-acceptance/fld_roofing.deck_condition/values",
      {
        data: {
          field_definition_revision_id: "rev_roofing.deck_condition",
          expected_version: 1,
          value: "Sound, one soft sheet",
          based_on_value_revision_id: null,
          correction_reason: null,
        },
      },
    );
    expect(elsewhere.status()).toBe(201);

    await page.getByTestId("schema-field-save-roofing.deck_condition").click();

    const conflict = page.getByTestId("schema-field-conflict-roofing.deck_condition");
    await expect(conflict).toContainText("Sound, one soft sheet");
    await expect(conflict).toContainText("Four soft sheets");
    // Evidence-classed, so it is a correction and the reason is not optional.
    await expect(page.getByTestId("schema-field-save-roofing.deck_condition")).toBeDisabled();

    await testInfo.attach("schema-job-card-conflict-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-conflict-390px.png`,
      }),
      contentType: "image/png",
    });

    await page.getByLabel("What are you correcting?").fill("Measured again after the tear-off");
    await page.getByTestId("schema-field-save-roofing.deck_condition").click();

    await expect(page.getByTestId("schema-field-roofing.deck_condition")).toHaveText(
      "Four soft sheets",
    );
    // The trail is on the card, where the next person to open the job will read it.
    await expect(page.getByTestId("schema-field-correction-roofing.deck_condition")).toHaveText(
      "Corrected: Measured again after the tear-off",
    );

    await testInfo.attach("schema-job-card-corrected-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-corrected-390px.png`,
      }),
      contentType: "image/png",
    });
  });

  test("keeps a value entered with no signal and sends it when signal returns", async ({
    context,
    page,
  }, testInfo) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("Not recorded");

    // Signal drops while the crew member has the job open — the common case on a roof, and the
    // one where the app must not lose what they type next.
    await context.setOffline(true);

    await page.getByTestId("schema-field-edit-permit_number").click();
    await page.getByTestId("schema-field-input-permit_number").fill("CAL-2026-8891");
    await page.getByTestId("schema-field-save-permit_number").click();

    // Held on the phone and said so — never rendered as the field's value, because the office
    // cannot see it yet.
    await expect(page.getByTestId("schema-field-pending-permit_number")).toHaveText(
      "Waiting to send: CAL-2026-8891",
    );
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("Not recorded");

    await testInfo.attach("schema-job-card-queued-offline-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-queued-offline-390px.png`,
      }),
      contentType: "image/png",
    });

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    // Sent on its own, and the card re-reads the record rather than promoting its own copy.
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("CAL-2026-8891", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("schema-field-pending-permit_number")).toHaveCount(0);

    await testInfo.attach("schema-job-card-synced-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/schema-job-card-synced-390px.png`,
      }),
      contentType: "image/png",
    });
  });

  test("holds a value entered after a cold start with no signal until the app reaches the server", async ({
    context,
    page,
  }) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("Not recorded");
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    // The harder case: the app is opened cold with no signal, so it boots from the service worker
    // against the offline session snapshot. Entry must still work and still be kept.
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    // Scoped to the card's own notice: the documents section renders its own (#203).
    await expect(page.getByTestId("schema-card-offline-notice")).toBeVisible();

    await page.getByTestId("schema-field-edit-permit_number").click();
    await page.getByTestId("schema-field-input-permit_number").fill("CAL-2026-8891");
    await page.getByTestId("schema-field-save-permit_number").click();

    await expect(page.getByTestId("schema-field-pending-permit_number")).toHaveText(
      "Waiting to send: CAL-2026-8891",
    );

    /*
     * An offline boot holds no CSRF token (`isOfflineSession`), and the outbox refuses to upload
     * without one — so this value waits for a live session rather than for the network alone.
     * That is app-wide behaviour for every queued field action, not something this card decides,
     * and the guarantee it makes is the one that matters here: nothing was thrown away.
     *
     * The live session comes back on this same page: the sign-in re-check that runs when the
     * network returns hands the outbox a fresh token, and the upload it starts holds a 90-second
     * lease (`OUTBOX_UPLOAD_LEASE_MS`) that a reopened page must wait out rather than send the
     * value twice. So the value reaches the server here before the card is opened again. As in
     * the test above, the online event is raised explicitly rather than left to the emulated
     * network change.
     */
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("CAL-2026-8891", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("schema-field-pending-permit_number")).toHaveCount(0);

    // Opened again, the card reads the value back from the server and holds nothing for it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("schema-field-permit_number")).toHaveText("CAL-2026-8891", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("schema-field-pending-permit_number")).toHaveCount(0);
  });
});

async function seedPairedFieldDevice(
  page: import("@playwright/test").Page,
  proof = "a".repeat(43),
) {
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
}
