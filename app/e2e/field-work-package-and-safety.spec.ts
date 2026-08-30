import { expect, test } from "@playwright/test";

// Mutation acceptance for the two components ELEC-88 found bus-solid but
// unproven: work packages (acknowledge -> start -> capture evidence ->
// complete) and safety (open panel, submit an action, see it reflected).
//
// Until acceptance-server.mjs grew handlers for /acknowledgements,
// /stop-work, /start, /complete, /check-ins, and /api/v1/safety/actions,
// these journeys were structurally impossible to run: the fixture server
// only ever answered GET. Every assertion below reads back mutated server
// state through the real PWA UI (not a raw API call), so a passing run is
// proof the frontend, the outbox, and the fixture's mutation contract agree.
//
// The fixture server's mutable state (acceptance-server.mjs) is one process
// shared by every project/worker, reset per test via /__acceptance__/reset.
// Running this file's project matrix concurrently with itself or with
// another spec that reads the same JOB-ACCEPTANCE fixture (field-pwa.spec.ts)
// races across workers. `playwright.config.ts` already forces `workers: 1`
// in CI, which is what actually gates merges; a local multi-worker run needs
// `--workers=1` to avoid the same race.

const fieldMode = (process.env.ACCEPTANCE_MODE ?? "field") === "field";

test.describe("Field mutation journeys (work package + safety)", () => {
  test.skip(!fieldMode, "requires ACCEPTANCE_MODE=field (the default)");

  test.beforeEach(async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/__acceptance__/reset`);
    expect(response.ok()).toBe(true);
  });

  test("work package: acknowledge -> start -> capture evidence into a slot -> complete", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await expect(page.getByText("v3 · Released")).toBeVisible();

    // 1. Review -- requires the review checkbox first, matching the real UI gate.
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "I reviewed this plan" }).click();
    await expect(page.getByText(/You reviewed this work plan/i)).toBeVisible();
    await expect(page.getByText("v3 · Reviewed")).toBeVisible();

    // 2. Start -- online-only direct command, not the offline outbox.
    await page.getByRole("button", { name: "Start work" }).click();
    await expect(page.getByText("v3 · In Progress")).toBeVisible();
    await expect(page.getByText(/No proof added yet/i).first()).toBeVisible();

    // 3. Capture evidence into the step:1 slot via the real check-in flow (multipart upload).
    await page.getByRole("link", { name: "Add proof for step 1" }).click();
    await expect(page.getByRole("heading", { name: "Add job proof" })).toBeVisible();
    await page.setInputFiles('input[type="file"][accept*="image"]', {
      name: "anchor-inspection.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    });
    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.getByRole("button", { name: "Save on device" }).click();
    await expect(page.getByRole("heading", { name: "Check-in saved" })).toBeVisible();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Return to job" }).click();
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    // Step 1's slot now reads back captured evidence; hold:1 was never captured, so
    // exactly one "No proof added yet" placeholder remains (the hold point).
    await expect(page.getByText(/No proof added yet/i)).toHaveCount(1);
    await expect(
      page.getByText("State: Open. Freshness: Current. Conflict: None.", { exact: true }),
    ).toBeVisible();

    // 4. Complete -- only reachable once the server-side ledger (ack + start + evidence) agrees.
    // The "current work package" read model (frappe-read.ts
    // FIELD_WORK_PACKAGE_CURRENT_STATUSES) only ever returns Released/Acknowledged/
    // In Progress, so a completed package reads back as no current package at all --
    // that is the state read-back that proves completion actually landed server-side.
    await page.getByRole("button", { name: "Finish work" }).click();
    await expect(page.getByRole("heading", { name: "No work plan is ready" })).toBeVisible();
  });

  test("safety: open the panel, submit a rescue call, see it reflected after reconnect", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();

    await page.locator("summary", { hasText: "Safety" }).click();
    await expect(page.getByRole("region", { name: /^safety$/i })).toBeVisible();
    await expect(page.getByRole("list", { name: "Active safety stops" })).toHaveCount(0);

    await page.getByRole("button", { name: "Call for rescue" }).click();
    await page
      .getByLabel(/what you saw/i)
      .fill("Worker suspended in harness on the north elevation, needs assisted descent.");
    // The status message renders as soon as the outbox write is queued, before the
    // background flush finishes -- wait on the actual network round trip so the
    // reload below reads back server state, not a client-only optimistic update.
    const flushed = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/safety/actions") &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Save and send" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved on this device" }),
    ).toBeVisible();
    await flushed;

    // The panel only fetches on mount, so force a remount to read back the server's
    // now-mutated state through /api/v1/safety/panel -- proving the round trip, not
    // just the local outbox write.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
    await page.locator("summary", { hasText: "Safety" }).click();
    const stops = page.getByRole("list", { name: "Active safety stops" });
    await expect(stops).toBeVisible();
    await expect(stops).toContainText("An active safety stop is in force");
    await expect(stops).toContainText("Emergency");
    await expect(stops).toContainText(
      "Worker suspended in harness on the north elevation, needs assisted descent.",
    );
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
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
}
