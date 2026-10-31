import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const suppliedFixture = process.env.ACCEPTANCE_PLAN_LIST === "mixed";
const fixturePort = suppliedFixture
  ? Number(process.env.ACCEPTANCE_PORT ?? "4273")
  : 4300 + Number(process.env.TEST_WORKER_INDEX ?? "0");
const fixtureBase = `http://127.0.0.1:${fixturePort}`;
let fixtureServer: ChildProcess | undefined;
test.use({ baseURL: fixtureBase });

// The server supplies explicitly synthetic instances of the actual job/typed GET projections.
// Only the paired-device credential is seeded. Successful cache receipts must be made by the
// production API/schema/cache code, never injected by this test.
test.describe("read-only saved work and safety plan", () => {
  test.beforeAll(async ({ playwright }) => {
    if (suppliedFixture) return;
    fixtureServer = spawn(process.execPath, ["scripts/acceptance-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(fixturePort),
        ACCEPTANCE_MODE: "field",
        ACCEPTANCE_ACTIVE_STOPS: "both",
        ACCEPTANCE_PLAN_LIST: "mixed",
        ACCEPTANCE_SITE_SAFETY_MISSING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    fixtureServer.stdout?.on("data", (chunk) => {
      log = (log + String(chunk)).slice(-5000);
    });
    fixtureServer.stderr?.on("data", (chunk) => {
      log = (log + String(chunk)).slice(-5000);
    });
    const probe = await playwright.request.newContext({ baseURL: fixtureBase });
    try {
      await expect
        .poll(
          async () => {
            if (fixtureServer?.exitCode !== null)
              throw new Error(`Saved-plan fixture stopped: ${log}`);
            try {
              return (await probe.get("/healthz", { timeout: 1000 })).ok();
            } catch {
              return false;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    } finally {
      await probe.dispose();
    }
  });

  test.afterAll(async () => {
    if (!fixtureServer || fixtureServer.exitCode !== null) return;
    const stopped = once(fixtureServer, "exit");
    fixtureServer.kill("SIGTERM");
    await stopped;
    fixtureServer = undefined;
  });

  test.beforeEach(async ({ request }) => {
    const response = await request.post("/__acceptance__/reset");
    expect(response.ok()).toBe(true);
  });

  test("job control opens real content and version, then the same route reloads from the actual offline cache", async ({
    page,
    context,
  }) => {
    await pairSyntheticDevice(page);
    await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Check what blocks work", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /The office must release every applicable stop, and all open work checks must also be cleared/,
      ),
    ).toBeVisible();
    const methods: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) methods.push(request.method());
    });
    await page.getByRole("link", { name: "Review saved job plan", exact: true }).click();
    await expect(page).toHaveURL(/\/jobs\/JOB-ACCEPTANCE\/plan$/);
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await page.getByText("System details", { exact: true }).click();
    await expect(page.getByText("Version 3 · Released", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Step 1 · Inspect anchors before roof access." }),
    ).toBeVisible();
    await expect(
      page.getByText("Secure loose materials and maintain the fall-protection boundary."),
    ).toBeVisible();
    await expect(page.getByText(/A separate site safety plan is unavailable/)).toBeVisible();
    await expect(
      page.getByText(/This check is open. Release authority: Production manager/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Start work|Finish work|I reviewed this plan|release/i }),
    ).toHaveCount(0);
    const before = await readReceipt(page, "ironwrap:appu_acceptance_field:job:JOB-ACCEPTANCE");
    expect(before.binding).toMatchObject({
      packageId: "WP-ACCEPTANCE-3",
      packageVersion: 3,
      tenantId: "ironwrap",
      userId: "appu_acceptance_field",
    });
    expect(before.acknowledged).toBe(false);
    expect(before.outboxCount).toBe(0);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Saved copy", { exact: true })).toBeVisible();
    await expect(page.getByText(/This saved plan may be old/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Step 1 · Inspect anchors before roof access." }),
    ).toBeVisible();
    expect(await readReceipt(page, "ironwrap:appu_acceptance_field:job:JOB-ACCEPTANCE")).toEqual(
      before,
    );
    expect(methods.every((method) => method === "GET")).toBe(true);
    await page.getByRole("link", { name: "Today", exact: true }).click();
    await expect(page.getByText("Work is stopped on every job.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Check what blocks work", exact: true }),
    ).toBeVisible();
  });

  test("typed work opens its own saved instructions offline without treating the object as a roof job", async ({
    page,
    context,
  }) => {
    const jobRequests: string[] = [];
    await pairSyntheticDevice(page);
    await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
    const receipt = await readReceipt(
      page,
      "ironwrap:appu_acceptance_field:work-object:Shop Order:SHOP-ACCEPTANCE:Shop Floor:SHOP-FLOOR-ACCEPTANCE",
    );
    expect(receipt.binding).toMatchObject({ packageId: "WP-SHOP-ACCEPTANCE-3", packageVersion: 3 });
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/jobs/")) jobRequests.push(request.url());
    });
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await context.setOffline(true);
    await page.getByRole("link", { name: "Review saved work plan", exact: true }).click();
    await expect(page).toHaveURL(
      /\/work-objects\/Shop%20Order\/SHOP-ACCEPTANCE\/physical-contexts\/Shop%20Floor\/SHOP-FLOOR-ACCEPTANCE\/plan$/,
    );
    await expect(
      page.getByRole("heading", { name: "Synthetic shop panel handling" }),
    ).toBeVisible();
    await expect(page.getByText("Training shop only; no roof work.")).toBeVisible();
    await expect(
      page.getByText("Secure loose stock, close the walkway and contact the office."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Start work|Finish work|I reviewed this plan|release/i }),
    ).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Synthetic shop panel handling" }),
    ).toBeVisible();
    expect(jobRequests).toEqual([]);
    expect(
      (
        await readReceipt(
          page,
          "ironwrap:appu_acceptance_field:work-object:Shop Order:SHOP-ACCEPTANCE:Shop Floor:SHOP-FLOOR-ACCEPTANCE",
        )
      ).outboxCount,
    ).toBe(0);
  });

  test("an unbound legacy packet refuses the plan viewer but still opens ordinary saved job details", async ({
    page,
    context,
  }) => {
    await pairSyntheticDevice(page);
    await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
    // Negative corruption only: remove the production-acquired context; never synthesize a success.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("ironwrap-os");
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("field_cache", "readwrite");
        const store = tx.objectStore("field_cache");
        const request = store.get("ironwrap:appu_acceptance_field:job:JOB-ACCEPTANCE");
        request.onsuccess = () => {
          const record = request.result;
          delete record.savedPlanBinding;
          store.put(record);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Not ready offline", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Review job plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    await expect(page.getByText(/Keep work stopped/)).toBeVisible();
    await page.getByRole("link", { name: "Today", exact: true }).click();
    await page.getByRole("link", { name: "Check what blocks work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
  });

  test("an auth transition in another tab withdraws the mounted plan before principal verification finishes", async ({
    page,
    context,
  }) => {
    await pairSyntheticDevice(page);
    await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Review saved job plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    const other = await context.newPage();
    // The actual consume UI/API client runs against the isolated synthetic server. Its refused
    // fake token is still an uncertain auth transition; it must not keep the old plan visible.
    const attempt = other.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/auth/magic-link/consume") && request.method() === "POST",
    );
    await other.goto("/auth/verify#token=synthetic-context-transition");
    await attempt;
    await expect(page.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toHaveCount(0);
    await other.close();
  });

  test("session expiry withdraws an already-open plan without relying on a failed network recheck", async ({
    page,
  }) => {
    const sessionResponse = await page.request.get("/api/v1/session");
    const session = await sessionResponse.json();
    await page.clock.install({ time: new Date(Date.parse(session.session_expires_at) - 60_000) });
    await pairSyntheticDevice(page);
    await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Review saved job plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await page.clock.fastForward(61_000);
    await expect(page.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toHaveCount(0);
  });
});

async function pairSyntheticDevice(page: Page) {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("ironwrap-os");
      request.onsuccess = () => resolve(request.result);
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
  await expect(page.getByRole("heading", { name: "Today's work", exact: true })).toBeVisible();
  await page.evaluate(async () => await navigator.serviceWorker.ready);
}

async function readReceipt(page: Page, key: string) {
  return await page.evaluate(async (cacheKey) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("ironwrap-os");
      request.onsuccess = () => resolve(request.result);
    });
    function read<T>(store: string, operation: (objectStore: IDBObjectStore) => IDBRequest<T>) {
      return new Promise<T>((resolve, reject) => {
        const request = operation(db.transaction(store).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const record = await read("field_cache", (store) => store.get(cacheKey));
    const outboxCount = await read("outbox_actions", (store) => store.count());
    db.close();
    return {
      binding: record?.savedPlanBinding,
      acknowledged:
        record?.value.packet?.work_package?.acknowledgement.current_user_acknowledged ??
        record?.value.work_package?.acknowledgement.current_user_acknowledged,
      outboxCount,
    };
  }, key);
}
