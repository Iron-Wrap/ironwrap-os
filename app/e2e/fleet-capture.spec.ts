import { mkdir } from "node:fs/promises";

import { devices, expect, test, type Page } from "@playwright/test";

// Mobile-first acceptance for the driver's vehicle rail (IRO-54 / ELEC-87).
//
// Mobile-first is a gating product rule: "contractors primarily work from their phones", and "a
// feature that degrades the mobile experience is not done". A pre-trip is the most literal case of
// it in the product — it is performed standing beside a truck, in gloves, on a phone.
//
// These run against the `field` acceptance profile, so they run in CI with the rest of the PWA
// suite rather than behind a separate opt-in script. They assert three things:
//
//  1. **The rail is reachable.** The field navigation reaches it, and all three captures POST to
//     the real capture endpoints — the gap ELEC-85 recorded as "implemented but unreachable".
//  2. **The refusal is comprehensible.** A blocked driver reads a sentence, never a policy code.
//  3. **The phone can work it.** No horizontal scrolling, and no control under 44 CSS px.
//
// Screenshots land in `.playwright-mobile/` as the delivery report's evidence.

const fieldMode = (process.env.ACCEPTANCE_MODE ?? "field") === "field";
const SHOT_DIR = ".playwright-mobile";

/** Pixel 5 is the project's mobile profile; 393 px is a common real contractor phone width. */
const MOBILE_WIDTH = 393;

async function assertNoHorizontalScroll(page: Page, screen: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${screen} scrolls sideways at ${overflow.clientWidth}px: content is ${overflow.scrollWidth}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function assertActionsAreReachable(page: Page, screen: string): Promise<void> {
  const controls = page.locator(
    "main button:visible, main a:visible, main select:visible, main textarea:visible",
  );
  const count = await controls.count();
  expect(count, `${screen} offers no controls at all`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    if (!box) continue;
    const label = (await control.textContent())?.trim().slice(0, 40) ?? `control ${index}`;
    expect(box.x, `${screen}: "${label}" starts off the left edge`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${screen}: "${label}" runs past the right edge`).toBeLessThanOrEqual(
      MOBILE_WIDTH + 1,
    );
    expect(box.height, `${screen}: "${label}" is only ${box.height}px tall`).toBeGreaterThanOrEqual(
      44,
    );
  }
}

/**
 * The check-point buttons are labels wrapping a visually hidden radio, so their
 * hit area is the label. Assert it directly rather than through the input.
 */
async function assertCheckPointTargets(page: Page): Promise<void> {
  const options = page.locator("main fieldset label:has(input[type=radio])");
  const count = await options.count();
  expect(count, "the walk-around offers no check points").toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await options.nth(index).boundingBox();
    if (!box) continue;
    expect(
      box.height,
      `check-point option ${index} is only ${box.height}px tall`,
    ).toBeGreaterThanOrEqual(44);
    expect(
      box.width,
      `check-point option ${index} is only ${box.width}px wide`,
    ).toBeGreaterThanOrEqual(44);
  }
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
}

// Pinned at file scope rather than inherited from the project: mobile-first is what is being
// asserted, so the viewport these run against must not depend on which project invoked them.
test.use({ ...devices["Pixel 5"] });

test.describe("Vehicle rail mobile acceptance", () => {
  test.skip(!fieldMode, "requires the field acceptance profile");

  test.beforeAll(async () => {
    await mkdir(SHOT_DIR, { recursive: true });
  });

  test.beforeEach(async ({ page, request }) => {
    await request.post("/__acceptance/fleet/reset");
    await seedPairedFieldDevice(page);
  });

  test("the field navigation reaches the vehicle rail on a phone", async ({ page }) => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Main navigation" }).last();
    const vehicle = nav.getByRole("link", { name: "Vehicle" });
    await expect(vehicle).toBeVisible();
    // The bar gained a fourth item; every item must still be a real thumb target.
    for (const label of ["Now", "Check-in", "Vehicle", "Settings"]) {
      const box = await nav.getByRole("link", { name: label }).boundingBox();
      expect(box?.height, `${label} tab is only ${box?.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box?.width, `${label} tab is only ${box?.width}px wide`).toBeGreaterThanOrEqual(44);
    }

    await vehicle.click();
    await expect(page.getByRole("heading", { name: "Vehicle", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Truck 12 flat deck" })).toBeVisible();
  });

  test("a blocked driver reads a sentence, not a policy code", async ({ page }) => {
    await page.goto("/vehicle");
    const blocked = page.getByRole("region", { name: "This one cannot go out yet" });
    await expect(blocked).toBeVisible();
    await expect(
      blocked.getByText(/Its inspection is out of date\. Record a pre-trip that passes/),
    ).toBeVisible();
    await expect(blocked.getByText(/overdue_fleet_inspection/)).toHaveCount(0);
    await expect(page.getByText(/next_inspection_due/)).toHaveCount(0);

    await assertNoHorizontalScroll(page, "vehicle");
    await assertActionsAreReachable(page, "vehicle");
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-blocked.png`, fullPage: true });
  });

  test("a pre-trip is filed from a phone and clears the block it was blocked by", async ({
    page,
  }) => {
    const captures: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/fleet/")) {
        captures.push(url.pathname);
      }
    });

    await page.goto("/vehicle");
    await page.getByRole("button", { name: "Pre-trip inspection" }).click();
    await expect(page.getByRole("form", { name: "Pre-trip inspection" })).toBeVisible();

    await assertNoHorizontalScroll(page, "pre-trip walk-around");
    await assertCheckPointTargets(page);
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-pre-trip.png`, fullPage: true });

    await page.getByRole("button", { name: "Save and send inspection" }).click();

    await expect(page.getByText(/Inspection saved on this device/)).toBeVisible();
    // The screen says "saved on this device" as soon as the outbox write lands; the upload runs
    // after it. Asserting the POST synchronously races that flush -- it wins on a fast machine and
    // loses on a loaded CI runner -- so poll for it instead.
    await expect
      .poll(() => captures)
      .toEqual(["/api/v1/fleet/assets/TRUCK-ACCEPTANCE/pre-trip-inspections"]);
    // The capture cleared the fence's own reason, re-read from the server.
    await expect(page.getByText(/Cleared to go out/)).toBeVisible();
    await expect(page.getByRole("region", { name: "This one cannot go out yet" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-cleared.png`, fullPage: true });
  });

  test("a post-trip is filed against its own endpoint", async ({ page }) => {
    const captures: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/fleet/")) {
        captures.push(url.pathname);
      }
    });

    await page.goto("/vehicle");
    await page.getByRole("button", { name: "Post-trip inspection" }).click();
    await page.getByRole("button", { name: "Save and send inspection" }).click();

    await expect(page.getByText(/Inspection saved on this device/)).toBeVisible();
    await expect
      .poll(() => captures)
      .toEqual(["/api/v1/fleet/assets/TRUCK-ACCEPTANCE/post-trip-inspections"]);
    await expect(page.getByText("Last post-trip")).toBeVisible();
  });

  test("an out-of-service fault warns before it parks the truck, then parks it", async ({
    page,
  }) => {
    const captures: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/fleet/")) {
        captures.push(url.pathname);
      }
    });

    await page.goto("/vehicle");
    await page.getByRole("button", { name: "Report a fault" }).click();
    const form = page.getByRole("form", { name: "Report a fault" });
    await form.getByRole("combobox", { name: "How bad is it" }).selectOption("Out of Service");
    await expect(page.getByText(/This parks it straight away/)).toBeVisible();
    await form
      .getByRole("textbox", { name: "What is wrong" })
      .fill("Air brake chamber leaking at the rear axle.");

    await assertNoHorizontalScroll(page, "fault report");
    await assertActionsAreReachable(page, "fault report");
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-fault.png`, fullPage: true });

    await page.getByRole("button", { name: "Save and send fault" }).click();

    await expect(page.getByText(/Do not use this one/)).toBeVisible();
    await expect.poll(() => captures).toEqual(["/api/v1/fleet/assets/TRUCK-ACCEPTANCE/defects"]);
    await expect(
      page.getByText(/This one is not in service\. Only the shop and the office/),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-grounded.png`, fullPage: true });
  });

  test("a walk-around done with no signal is kept, not lost", async ({ context, page }) => {
    await page.goto("/vehicle");
    await expect(page.getByRole("heading", { name: "Truck 12 flat deck" })).toBeVisible();
    await context.setOffline(true);

    await page.getByRole("button", { name: "Pre-trip inspection" }).click();
    const brakes = page.getByRole("group", { name: "Brakes and air system" });
    // The thumb target is the label; its radio is visually hidden by design.
    await brakes.locator("label", { hasText: "Fault" }).click();
    await expect(brakes.getByRole("radio", { name: "Fault" })).toBeChecked();
    await brakes
      .getByRole("textbox", { name: "What you found" })
      .fill("Slack adjuster past its travel limit.");
    await page.getByRole("button", { name: "Save and send inspection" }).click();

    await expect(page.getByText(/Inspection saved on this device/)).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/vehicle-offline-saved.png`, fullPage: true });

    // The capture is durable on the device, not held in a React state that a
    // locked screen or a dead battery would take with it.
    const queued = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ironwrap-os");
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      try {
        return await new Promise<Array<{ kind: string; endpoint: string; state: string }>>(
          (resolve, reject) => {
            const request = database
              .transaction("outbox_actions", "readonly")
              .objectStore("outbox_actions")
              .getAll();
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          },
        );
      } finally {
        database.close();
      }
    });
    expect(queued.map((action) => [action.kind, action.endpoint, action.state])).toEqual([
      [
        "fleet_pre_trip_inspection",
        "/api/v1/fleet/assets/TRUCK-ACCEPTANCE/pre-trip-inspections",
        "queued",
      ],
    ]);
    await context.setOffline(false);
  });
});
