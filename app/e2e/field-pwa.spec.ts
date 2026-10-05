import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectTouchTarget } from "./touch-target";
import { settleAnimations } from "./settle";

test.describe("Field Companion PWA acceptance", () => {
  test("keeps the full crew name, Sun mode, and thumb actions usable on narrow phones", async ({
    page,
  }) => {
    await page.route("**/api/v1/field/bootstrap", async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      if (model.session?.user) model.session.user.display_name = "Sam Kennedy Long Example Name";
      await route.fulfill({ response, json: model });
    });
    await seedPairedFieldDevice(page);
    await page.reload();
    await page.getByRole("button", { name: "Sun mode" }).click();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const name = page.locator(".crew-person strong");
      await expect(name).toHaveText("Sam Kennedy Long Example Name");
      await expect(name).toHaveCSS("white-space", "normal");
      expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expect(page.locator(".crew")).toHaveAttribute("data-environment", "field-sun");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      for (const control of await page.locator(".crew-top > :is(button,a)").all()) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(48);
        expect(box.width).toBeGreaterThanOrEqual(48);
      }
    }
    await page.reload();
    await expect(page.locator(".crew")).toHaveAttribute("data-environment", "field-sun");
    await page.goto("/jobs/JOB-ACCEPTANCE");
    const camera = page.locator(".field-capture-dock");
    const cameraBox = (await camera.boundingBox())!;
    const tabsBox = (await page.locator(".crew-tabs").boundingBox())!;
    expect(cameraBox.height).toBeGreaterThanOrEqual(48);
    expect(cameraBox.y + cameraBox.height).toBeLessThan(tabsBox.y);
    await page.goto("/check-in/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "Capture what you see" })).toBeFocused();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const capture = page.getByText("Take photos", { exact: true }).locator("..");
      const captureBox = (await capture.boundingBox())!;
      const actionBox = (await page.locator(".field-action-bar").boundingBox())!;
      const headerBox = (await page.locator(".crew-top").boundingBox())!;
      expect(captureBox.height).toBeGreaterThanOrEqual(64);
      expect(captureBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
      expect(captureBox.y + captureBox.height).toBeLessThanOrEqual(actionBox.y);
      expect(actionBox.y + actionBox.height).toBeLessThan(tabsBox.y);
    }
  });

  for (const width of [320, 412, 576]) {
    test(`keeps the run sheet in place when installation becomes available at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 915 });
      await seedPairedFieldDevice(page);
      await page.addInitScript(() => {
        window.addEventListener(
          "beforeinstallprompt",
          (event) => {
            if (event.isTrusted) event.stopImmediatePropagation();
          },
          true,
        );
        Object.defineProperty(navigator.storage, "persisted", { value: async () => true });
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
      await expect(page.getByRole("status", { name: "Sync: All sent" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      const before = await page.locator("#main-content").boundingBox();

      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.assign(event, {
          prompt: async () => {},
          userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
        });
        window.dispatchEvent(event);
      });

      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
      const after = await page.locator("#main-content").boundingBox();
      expect(after!.y).toBe(before!.y);
      const install = page.getByRole("button", { name: "Install", exact: true });
      const help = page.getByRole("button", { name: "Help", exact: true });
      await expectTouchTarget(install, { name: "Install" });
      await expectTouchTarget(help, { name: "Help" });
      const horizontalLayout = await page.evaluate(() => ({
        contentWidth: document.documentElement.scrollWidth,
        availableWidth: Math.min(
          document.documentElement.clientWidth,
          document.documentElement.getBoundingClientRect().width,
        ),
      }));
      // Stable gutters reduce visible width even when headless Chromium hides scrollbars.
      expect(horizontalLayout.contentWidth).toBeLessThanOrEqual(horizontalLayout.availableWidth);
      await install.focus();
      await expect(install).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(install).toHaveCount(0);
      expect((await page.locator("#main-content").boundingBox())!.y).toBe(before!.y);
      await help.click();
      await expect(page.getByRole("button", { name: "Call for rescue" })).toBeVisible();
    });
  }

  test("renders a mobile-safe blocked-work run sheet with no WCAG A/AA violations", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.route("**/api/v1/operating-intake", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          operating_authority: "d1",
          tenant_id: "ironwrap",
          generated_at: "2026-08-21T16:00:00.000Z",
          leads: [],
        }),
      }),
    );
    const appRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) appRequests.push(url.pathname);
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.locator("#app-boot-shell")).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
    await expect(page.getByText("1 check blocks work")).toBeVisible();
    await expect(page.getByText("Delivery confirmation is missing")).toBeVisible();
    await expect(page.getByRole("link", { name: "Check what blocks work" })).toHaveAttribute(
      "href",
      "/jobs/JOB-ACCEPTANCE",
    );
    await expect(page.getByRole("link", { name: "Start work" })).toHaveCount(0);
    expect(appRequests).toContain("/api/v1/field/bootstrap");
    expect(appRequests).not.toContain("/api/v1/session");
    expect(appRequests).not.toContain("/api/v1/today");

    const reviewAction = page.getByRole("link", { name: "Check what blocks work" });
    await expectTouchTarget(reviewAction, { name: "Check what blocks work" });

    // Open the safety rail before auditing. Its controls are the highest-contrast
    // risk on the shell, and a closed <details> would hide them from axe entirely.
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByRole("button", { name: "Call for rescue" })).toBeVisible();

    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("registers an installable shell and reloads the cached dispatch offline", async ({
    context,
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

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

    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByText(/This is a saved copy for/i)).toBeVisible();
    await expect(page.getByText(/Your saved work is safe/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
  });

  test("keeps a cached Work Package readable offline without a client-side start or hold release", async ({
    context,
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await expect(page.getByText("v3 · Released")).toBeVisible();
    await expect(page.getByText(/Waiting for Production manager/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByText(/This is a saved copy from/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "I reviewed this plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work" })).toHaveCount(0);
    await expect(page.getByText(/this app cannot clear the stop/i)).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
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

    await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today's work" })).toHaveCount(0);
    expect(bootstrapRequests).toEqual([{ deviceProof: undefined }]);
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
