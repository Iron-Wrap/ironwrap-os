import { mkdir } from "node:fs/promises";

import { devices, expect, test, type Page } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

// Mobile-first acceptance for step 3 of the core workflow (ELEC-94 / ELEC-89).
//
// Step 3 -- "apply materials, products, and colors" -- did not exist as a traversable path in
// this repo at all before this slice. The competitor benchmark for it is a shareable interactive
// experience a homeowner opens on their phone from a text message, so mobile is not a rendering
// detail here: it is the primary and probably only device this screen is ever seen on.
//
// Until this file, `/portal` had zero e2e coverage of any kind. These assert four things:
//
//  1. **The comparison is reachable.** A magic-link fragment lands on a portal that actually
//     shows the curated options between the approved scope and verified progress.
//  2. **Choosing posts to the real route.** The button reaches
//     `/api/v1/customer-portal/decision` with an Idempotency-Key -- not a local state flip.
//  3. **The confirmation is honest.** A provisional preference must not read as an order.
//  4. **The phone can work it.** No horizontal scrolling, and no control under 44 CSS px.
//
// Screenshots land in `.playwright-mobile/` as the delivery report's evidence.

const fieldMode = (process.env.ACCEPTANCE_MODE ?? "field") === "field";
const SHOT_DIR = ".playwright-mobile";

/** Pixel 5 is the project's mobile profile; 393 px is a common real customer phone width. */
const MOBILE_WIDTH = 393;
const PORTAL_TOKEN = "p".repeat(43);

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
  const controls = page.locator("main button:visible, main a:visible");
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
    await expectTouchTarget(control, { name: `${screen}: "${label}"`, axis: "height" });
  }
}

async function openPortal(page: Page): Promise<void> {
  await page.goto(`/portal#token=${PORTAL_TOKEN}`);
  await expect(page.getByRole("heading", { name: "Your project", level: 1 })).toBeVisible();
  await expect(page.getByText("IW-2026-100", { exact: false })).toBeVisible();
  const overview = page.getByRole("region", { name: "Project overview" });
  await expect(overview.getByText("Wednesday, August 26, 2026")).toBeVisible();
  await expect(overview.getByText("Work planned from 8:00 a.m. to 4:00 p.m.")).toBeVisible();
}

// Pinned at file scope rather than inherited from the project: mobile-first is what is being
// asserted, so the viewport these run against must not depend on which project invoked them.
test.use({ ...devices["Pixel 5"] });

test.describe("Customer portal materials mobile acceptance", () => {
  test.skip(!fieldMode, "requires the default acceptance profile");

  test.beforeAll(async () => {
    await mkdir(SHOT_DIR, { recursive: true });
  });

  test.beforeEach(async ({ request }) => {
    await request.post("/__acceptance/customer-portal/reset");
  });

  test("a magic-link portal reaches the option comparison on a phone", async ({ page }) => {
    await openPortal(page);

    // The token never survives in the URL the customer could share or a referrer could leak.
    expect(new URL(page.url()).hash).toBe("");
    const overview = page.getByRole("region", { name: "Project overview" });
    await expect(overview.getByText(/IronWrap Exteriors booked this time/)).toBeVisible();
    await expect(overview.getByText("Amount not yet shared")).toBeVisible();
    await expect(
      overview.getByRole("link", { name: "Choose materials and colours" }),
    ).toHaveAttribute("href", "#project-materials");
    for (const control of await page.getByRole("button").all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }

    const materials = page.getByRole("heading", { name: "Materials and colours" });
    await expect(materials).toBeVisible();
    for (const name of [
      "Weathered slate asphalt",
      "Charcoal standing seam",
      "Matte black snap-lock",
    ]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    // Cheapest first, by the DocType's own Good/Better/Best tier order.
    await expect(page.getByText("In your current price")).toBeVisible();
    await expect(page.getByText("Costs $2,400 more")).toBeVisible();

    await assertNoHorizontalScroll(page, "portal materials");
    await assertActionsAreReachable(page, "portal materials");
    await page.screenshot({ path: `${SHOT_DIR}/portal-materials.png`, fullPage: true });
  });

  test("choosing an option posts the real decision route and confirms without over-claiming", async ({
    page,
  }) => {
    const posts: Array<{ path: string; idempotencyKey: string | undefined; body: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/customer-portal/")) {
        posts.push({
          path: url.pathname,
          idempotencyKey: request.headers()["idempotency-key"],
          body: request.postData() ?? "",
        });
      }
    });

    await openPortal(page);
    const card = page.getByRole("region", { name: "Charcoal standing seam" });
    await card.getByRole("button", { name: "Pick this option" }).click();

    await expect(page.getByRole("status")).toContainText("You picked Charcoal standing seam");
    // A preference is not a purchase. The sentence has to say so.
    await expect(page.getByRole("status")).toContainText("does not order or bill anything");
    await expect(card.getByRole("button", { name: "Chosen" })).toBeDisabled();

    const decision = posts.find((post) => post.path === "/api/v1/customer-portal/decision");
    expect(decision, "the button never reached the decision route").toBeTruthy();
    expect(decision!.idempotencyKey).toMatch(/^portal-decision:opt-better:/);
    expect(JSON.parse(decision!.body)).toEqual({
      token: PORTAL_TOKEN,
      option_package_id: "opt-better",
    });

    await assertNoHorizontalScroll(page, "portal materials chosen");
    await assertActionsAreReachable(page, "portal materials chosen");
    await page.screenshot({ path: `${SHOT_DIR}/portal-materials-chosen.png`, fullPage: true });
  });

  test("the recorded choice reaches the server, once per decision", async ({ page, request }) => {
    await openPortal(page);
    await page
      .getByRole("region", { name: "Matte black snap-lock" })
      .getByRole("button", { name: "Pick this option" })
      .click();
    await expect(page.getByRole("status")).toContainText("You picked Matte black snap-lock");

    const recorded = await (await request.get("/__acceptance/customer-portal/decisions")).json();
    expect(recorded.decisions).toHaveLength(1);
    expect(recorded.decisions[0].option_package_id).toBe("opt-best");
  });

  test("a failed choice reads as a sentence a customer can act on", async ({ page }) => {
    await openPortal(page);
    await page.route("**/api/v1/customer-portal/decision", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "decision_rejected" }),
      }),
    );

    await page
      .getByRole("region", { name: "Charcoal standing seam" })
      .getByRole("button", { name: "Pick this option" })
      .click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/could not save your choice/i);
    await expect(page.getByText("decision_rejected")).toHaveCount(0);

    await assertNoHorizontalScroll(page, "portal materials error");
    await page.screenshot({ path: `${SHOT_DIR}/portal-materials-error.png`, fullPage: true });
  });
});
