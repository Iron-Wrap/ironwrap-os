import { expect, test, type Page } from "@playwright/test";

const jobPlan = "/jobs/JOB-ACCEPTANCE/plan";
const typedPlan =
  "/work-objects/Shop%20Order/SHOP-ACCEPTANCE/physical-contexts/Shop%20Floor/SHOP-FLOOR-ACCEPTANCE/plan";

async function acquire(page: Page) {
  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "Pair this crew phone", exact: true }),
  ).toBeVisible();
  // Only the synthetic paired credential is seeded. Auth observations and package receipts must
  // be produced by the actual API/schema/transaction/cache path.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open("ironwrap-os");
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        key: "field-device-secret-v1",
        value: { value: "a".repeat(43), createdAt: Date.now() },
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

test.describe("principal recovery preventive policy v1 built PWA", () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post("/__acceptance__/reset")).ok()).toBe(true);
  });

  test("healthy job and first typed entry/reload stay full and local even with an online hint and failed transport", async ({
    page,
  }, testInfo) => {
    await acquire(page);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    const attempts: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      attempts.push(new URL(route.request().url()).pathname);
      await route.abort("failed");
    });
    for (const [path, title, instruction] of [
      [jobPlan, "North slope replacement", "Install roof panels in sequence"],
      [
        typedPlan,
        "Synthetic shop panel handling",
        "Secure loose stock, close the walkway and contact the office.",
      ],
    ]) {
      await page.goto(path!, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: title!, exact: true })).toBeVisible();
      await expect(page.getByText("Saved copy", { exact: true })).toBeVisible();
      if (path === typedPlan) await expect(page.getByText(instruction!)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Start work|Finish work|I reviewed this plan|release/i }),
      ).toHaveCount(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: title!, exact: true })).toBeVisible();
    }
    expect(attempts).toEqual([]);
    await testInfo.attach("local-only-transport-proof", {
      contentType: "application/json",
      body: JSON.stringify({
        onlineHint: true,
        protectedApiAttempts: attempts,
        fullJobAndTypedPlan: true,
        screenshots: false,
      }),
    });
  });

  test("a real other-tab consume HTTP success followed by storage failure stays refused across reload", async ({
    page,
    context,
  }, testInfo) => {
    await acquire(page);
    await page.getByRole("link", { name: "Review saved job plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    const other = await context.newPage();
    let effects = 0;
    await other.route("**/api/v1/auth/magic-link/consume", async (route) => {
      const pending = await other.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open("ironwrap-os");
          open.onsuccess = () => resolve(open.result);
        });
        const value = await new Promise<{ value?: { pending?: string[] } }>((resolve) => {
          const get = db.transaction("meta").objectStore("meta").get("field-principal-epoch-v1");
          get.onsuccess = () => resolve(get.result);
        });
        db.close();
        return value?.value?.pending?.length ?? 0;
      });
      expect(pending).toBeGreaterThan(0);
      await other.evaluate(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "ironwrap.principal-read-generation-v1")
            throw new DOMException("Synthetic generation failure", "QuotaExceededError");
          return set.call(this, key, value);
        };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, options) {
          if (mode === "readwrite")
            throw new DOMException("Synthetic epoch failure", "QuotaExceededError");
          return transaction.call(this, names, mode, options);
        };
      });
      effects += 1;
      // This fixture models the inspected Worker's successful cookie-setting response. It is
      // client execution proof, not deployed cookie/runtime acceptance.
      await route.fulfill({ status: 204, body: "" });
    });
    await other.goto("/auth/verify#token=synthetic-prepared-transition");
    await expect.poll(() => effects).toBe(1);
    await expect(
      other.getByRole("heading", { name: "Sign-in needs checking", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toHaveCount(0);
    await other.close(); // Releases only this test's page; fault overrides disappear with it.
    await page.route("**/api/v1/**", (route) => route.abort("failed"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toHaveCount(0);
    await testInfo.attach("completed-transition-refusal", {
      contentType: "application/json",
      body: JSON.stringify({
        preparedBeforeHttp: true,
        modeledConsumeSuccesses: effects,
        oldPlanRefusedAfterReload: true,
        runtimeAcceptance: false,
      }),
    });
  });

  test("a zero-preparation other-tab attempt sends nothing and cannot claim sign-in success", async ({
    page,
    context,
  }, testInfo) => {
    await acquire(page);
    const other = await context.newPage();
    await other.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "ironwrap.principal-read-generation-v1")
          throw new DOMException("Synthetic generation failure", "QuotaExceededError");
        return set.call(this, key, value);
      };
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        if (mode === "readwrite")
          throw new DOMException("Synthetic epoch failure", "QuotaExceededError");
        return transaction.call(this, names, mode, options);
      };
    });
    const attempts: string[] = [];
    await other.route("**/api/v1/**", async (route) => {
      attempts.push(new URL(route.request().url()).pathname);
      await route.abort("failed");
    });
    await other.goto("/auth/verify#token=synthetic-not-dispatched");
    await expect(
      other.getByRole("heading", { name: "Sign-in was not sent", exact: true }),
    ).toBeVisible();
    expect(attempts).toEqual([]);
    expect(new URL(other.url()).pathname).toBe("/auth/verify");
    await other.close();
    await page.route("**/api/v1/**", (route) => route.abort("failed"));
    await page.goto(jobPlan, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await testInfo.attach("refused-before-effect", {
      contentType: "application/json",
      body: JSON.stringify({
        apiAttempts: attempts,
        truthfulNoDispatch: true,
        healthySavedPlanAfterRefusal: true,
      }),
    });
  });
});
