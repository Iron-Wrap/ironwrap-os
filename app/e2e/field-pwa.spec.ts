import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Field Companion PWA acceptance", () => {
  test("renders a mobile-safe blocked-work run sheet with no WCAG A/AA violations", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    const appRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) appRequests.push(url.pathname);
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await expect(page.locator("#app-boot-shell")).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await expect(page.getByRole("heading", { name: "Run sheet" })).toBeVisible();
    await expect(page.getByText("1 gate blocks work")).toBeVisible();
    await expect(page.getByText("Delivery confirmation is missing")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review gate and packet" })).toHaveAttribute(
      "href",
      "/jobs/JOB-ACCEPTANCE",
    );
    await expect(page.getByRole("link", { name: "Start work" })).toHaveCount(0);
    expect(appRequests).toContain("/api/v1/field/bootstrap");
    expect(appRequests).not.toContain("/api/v1/session");
    expect(appRequests).not.toContain("/api/v1/today");

    const reviewAction = page.getByRole("link", { name: "Review gate and packet" });
    const bounds = await reviewAction.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("registers an installable shell and reloads the cached dispatch offline", async ({
    context,
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const manifest = await page.evaluate(async (href) => {
      return await (await fetch(href)).json();
    }, manifestHref!);
    expect(manifest).toMatchObject({
      id: "/",
      name: "IronWrap OS",
      short_name: "IronWrap",
      start_url: "/today",
      display: "standalone",
    });

    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await expect(page.getByText("Offline snapshot", { exact: true })).toBeVisible();
    await expect(page.getByText(/Saved work remains queued/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
  });

  test("uses one proof-bound bootstrap read for an already paired field device", async ({
    page,
  }) => {
    const deviceProof = "a".repeat(43);
    await seedPairedFieldDevice(page, deviceProof);

    const bootstrapRequests: Array<{ deviceProof?: string }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/v1/field/bootstrap") return;
      bootstrapRequests.push({ deviceProof: request.headers()["x-ironwrap-device-proof"] });
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Run sheet" })).toBeVisible();
    expect(bootstrapRequests).toEqual([{ deviceProof }]);
  });

  test("never receives run-sheet data before a paired device supplies its proof", async ({
    page,
  }) => {
    const bootstrapRequests: Array<{ deviceProof?: string }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/v1/field/bootstrap") return;
      bootstrapRequests.push({ deviceProof: request.headers()["x-ironwrap-device-proof"] });
    });

    await page.goto("/today");

    await expect(page.getByRole("heading", { name: "Sign in to IronWrap OS" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run sheet" })).toHaveCount(0);
    expect(bootstrapRequests).toEqual([{ deviceProof: undefined }]);
  });
});

async function seedPairedFieldDevice(
  page: import("@playwright/test").Page,
  proof = "a".repeat(43),
) {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Sign in to IronWrap OS" })).toBeVisible();
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
