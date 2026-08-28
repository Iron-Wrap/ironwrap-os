import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
    await expect(page.getByText(/Showing the copy saved on this device/i)).toBeVisible();

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
