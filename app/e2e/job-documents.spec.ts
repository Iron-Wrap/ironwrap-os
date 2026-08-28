import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The documents a job carries, on the phone the work is done from.
 *
 * The stakeholder requirement is that a materials list is a smart form filled from the job and
 * reachable in the workflow, not a file in a separate area. These run against the field acceptance
 * fixture, whose job carries a materials-list template with one binding the reader is not
 * authorized for — so a single pass covers the filled document, the withheld line, the mobile
 * layout, and the offline copy.
 */

const PHONE = { width: 390, height: 844 };

test.describe("Documents on the job workflow surface", () => {
  test.beforeEach(async ({ page }) => {
    await seedPairedFieldDevice(page);
  });

  test("fills the job's materials list on a 390px phone without leaving the job", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    const materialsList = page.getByTestId("document-toggle-materials_list");
    await expect(materialsList).toBeVisible();
    await expect(materialsList).toHaveAttribute("aria-expanded", "true");

    // Every line comes from this job's own values — nothing on this surface is typed by hand.
    await expect(page.getByRole("heading", { name: "Order for the shop" })).toBeVisible();
    await expect(page.getByTestId("document-line-roofing.underlayment")).toHaveText("Synthetic");
    await expect(page.getByTestId("document-line-gutters.linear_feet")).toHaveText("142");
    await expect(page.getByTestId("document-line-gutters.downspouts")).toHaveText("6");

    // A configured but unfilled field stays on the document and says so, rather than vanishing.
    await expect(page.getByTestId("document-line-permit_number")).toHaveText("Not recorded");

    // The binding the crew's record read never carried: named, blank, and never guessed.
    await expect(page.getByTestId("document-line-fld_margin_band")).toHaveText(
      "Not shared with your role",
    );
    await expect(page.getByTestId("document-withheld-note")).toHaveText(
      "One line is not shared with your role.",
    );

    // The two blank states must differ by more than their wording, for a shop scanning fast.
    const rowState = (testId: string) =>
      page.getByTestId(testId).locator("xpath=ancestor::*[@data-line-state][1]");
    await expect(rowState("document-line-permit_number")).toHaveAttribute(
      "data-line-state",
      "empty",
    );
    await expect(rowState("document-line-fld_margin_band")).toHaveAttribute(
      "data-line-state",
      "withheld",
    );
    await expect(rowState("document-line-fld_margin_band").locator("svg")).toBeVisible();
    await expect(rowState("document-line-permit_number").locator("svg")).toHaveCount(0);

    // Nothing may overflow the phone: a document that spills sideways is one nobody can read.
    const documentWidth = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth,
    );
    expect(documentWidth).toBeLessThanOrEqual(PHONE.width);

    await testInfo.attach("job-documents-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/job-documents-390px.png`,
      }),
      contentType: "image/png",
    });
    // The section on its own: a full-page phone capture of the whole job packet is too tall to
    // read as evidence, and the acceptance line is about this surface.
    await testInfo.attach("job-documents-section-390px.png", {
      body: await page.getByTestId("entity-documents").screenshot({
        path: `test-results/evidence/job-documents-section-390px.png`,
      }),
      contentType: "image/png",
    });
    // The two "nothing" states beside each other, which is the finding this treatment answers:
    // "Not recorded" plain, "Not shared with your role" locked and edged (ELEC-197).
    await testInfo.attach("job-documents-empty-vs-withheld-390px.png", {
      body: await page.getByTestId("document-body-materials_list").screenshot({
        path: `test-results/evidence/job-documents-empty-vs-withheld-390px.png`,
      }),
      contentType: "image/png",
    });

    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("collapses and reopens a document with one press", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");

    // `click()`, not `tap()`: the disclosure is a real button and CI also runs the two
    // Desktop-Chrome projects, which carry no touch support.
    const materialsList = page.getByTestId("document-toggle-materials_list");
    await expect(materialsList).toHaveAttribute("aria-expanded", "true");
    await materialsList.click();
    await expect(materialsList).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("document-line-gutters.linear_feet")).toBeHidden();
    await materialsList.click();
    await expect(page.getByTestId("document-line-gutters.linear_feet")).toBeVisible();
  });

  test("keeps the materials list readable offline once the crew has opened the job", async ({
    context,
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByTestId("document-line-gutters.linear_feet")).toHaveText("142");
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(page.getByTestId("document-line-gutters.linear_feet")).toHaveText("142");
    await expect(page.getByTestId("documents-offline-notice")).toHaveText(
      /These documents are the copy saved on this device/i,
    );

    await testInfo.attach("job-documents-offline-390px.png", {
      body: await page.screenshot({
        fullPage: true,
        path: `test-results/evidence/job-documents-offline-390px.png`,
      }),
      contentType: "image/png",
    });

    await context.setOffline(false);
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
