import { devices, expect, test } from "@playwright/test";

// Role-matrix acceptance for the Sep 1 field walkthrough (IRO-42).
// Field devices stay on crew rails; Settings pairing is owner/ops only.
// Photo + check-in mutation coverage lives in field-work-package-and-safety.spec.ts.

const fieldMode = (process.env.ACCEPTANCE_MODE ?? "field") === "field";

test.use({ ...devices["Pixel 5"] });

test.describe("Field role matrix", () => {
  test.skip(!fieldMode, "requires ACCEPTANCE_MODE=field (the default)");

  test("crew navigation is Now/Check-in/Vehicle/Inventory and never office work", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    const nav = page.locator('nav[aria-label="Main navigation"]:visible');
    for (const label of ["Now", "Check-in", "Vehicle", "Inventory"]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Designs" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Sales" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Production" })).toHaveCount(0);
  });

  test("Settings pairing is refused for a paired field device", async ({ page }) => {
    await seedPairedFieldDevice(page);
    await page.goto("/settings");
    await expect(page.getByText("This work belongs to another role")).toBeVisible();
    await expect(page.getByRole("button", { name: "Issue one-time QR code" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Return to Now" })).toBeVisible();
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
