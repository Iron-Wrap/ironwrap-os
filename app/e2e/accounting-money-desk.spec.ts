import { mkdir } from "node:fs/promises";

import { devices, expect, test, type Page } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";
import { expectTouchTarget } from "./touch-target";

import { quickBooksFinalInvoiceFixture } from "../src/accounting/quickbooks-test-fixture";

// Mobile-first acceptance for the money desk (IRO-52 slice S9).
//
// Mobile-first is a gating product rule, not a preference: "contractors primarily work from their
// phones", and "a feature that degrades the mobile experience is not done". These run against the
// `accounting` acceptance profile and assert the two things that decide whether an office manager
// can actually work a queue on a phone:
//
//  1. **No horizontal scrolling.** `documentElement.scrollWidth` must not exceed the viewport, on
//     every screen. A queue that scrolls sideways hides the column the decision depends on.
//  2. **No hidden actions.** Every control the screen offers must be inside the viewport width and
//     at least 44 CSS px tall, which is the smallest thing a thumb reliably hits.
//
// They also write a screenshot per screen to `.playwright-mobile/`, which is the evidence the
// delivery report attaches.

const accountingMode = process.env.ACCEPTANCE_MODE === "accounting";
const INTENT_ID = "acct-intent:JOB-ACCEPTANCE:deposit_invoice";
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
  const controls = page.locator("main button:visible, main a:visible, main select:visible");
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

// Pinned at file scope rather than inherited from the project: mobile-first is what is being
// asserted, so the viewport these run against must not depend on which project invoked them.
// Playwright refuses a device `use()` inside a describe group, because it forces a new worker.
test.use({ ...devices["Pixel 5"] });

test.describe("Money desk mobile acceptance", () => {
  test.skip(!accountingMode, "requires ACCEPTANCE_MODE=accounting");

  test.beforeAll(async () => {
    await mkdir(SHOT_DIR, { recursive: true });
  });

  test("the money desk works the queues without sideways scrolling", async ({ page }) => {
    await page.goto("/accounting");
    await expect(page.getByRole("heading", { name: "Money desk" })).toBeVisible();

    // The four queues section 8.2 names, all reachable by scrolling down and nothing else.
    for (const queue of [
      "Needs approval",
      "Waiting for QuickBooks",
      "Does not match",
      "Money issues",
    ]) {
      await expect(page.getByRole("heading", { name: queue })).toBeVisible();
    }
    // A row carries its own next step, in words.
    await expect(
      page.getByText("Check the amount against the approved paperwork, then approve or reject it."),
    ).toBeVisible();
    // ...and the words track the truth. A posted invoice nobody has paid yet is waiting on the
    // customer, not "part paid": slice S11 made `reconciled` reachable, and a queue whose copy
    // described a state it could never leave was the other half of that gap (ELEC-77).
    await expect(
      page.getByText("Posted to QuickBooks. Waiting for the customer to pay it."),
    ).toBeVisible();

    await assertNoHorizontalScroll(page, "money desk");
    await assertActionsAreReachable(page, "money desk");
    await page.screenshot({ path: `${SHOT_DIR}/money-desk.png`, fullPage: true });
  });

  test("an intent's state and actions read on a phone without hidden controls", async ({
    page,
  }) => {
    await page.goto(`/accounting/intents/${encodeURIComponent(INTENT_ID)}`);
    await expect(page.getByRole("heading", { name: "Deposit invoice" })).toBeVisible();
    await expect(page.getByText("CAD 1260.00")).toBeVisible();
    await expect(page.getByText("Pending", { exact: true })).toBeVisible();

    // Every action the role is allowed is on the screen, at a thumb-sized target.
    await expect(
      page.getByRole("button", { name: "Approve and send to QuickBooks" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Do not approve" })).toBeVisible();
    // The comparison is readable without a table that scrolls sideways.
    await expect(page.getByRole("region", { name: "IronWrap and QuickBooks" })).toBeVisible();

    await assertNoHorizontalScroll(page, "intent detail");
    await assertActionsAreReachable(page, "intent detail");
    await page.screenshot({ path: `${SHOT_DIR}/money-intent.png`, fullPage: true });
  });

  test("the money issue queue offers safe choices without a sideways scroll", async ({ page }) => {
    await page.goto("/accounting/exceptions");
    await expect(page.getByRole("heading", { name: "Money issues", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "More was paid than was invoiced" }),
    ).toBeVisible();

    // A reversal is authorized on the money movement and dispatched by the system, so the queue
    // points there instead of offering a box to type a reference into. The box is what ELEC-71
    // closed a real $240 overpayment with, using a string it invented on the spot.
    await expect(page.getByText(/To put money back, open the money item/)).toBeVisible();
    await expect(page.getByLabel("Reference of the reversal in QuickBooks")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the money item" })).toBeVisible();
    // Section 8.2: reversal is provider-supported, never a delete.
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);

    await assertNoHorizontalScroll(page, "exception queue");
    await assertActionsAreReachable(page, "exception queue");
    await page.screenshot({ path: `${SHOT_DIR}/money-exceptions.png`, fullPage: true });
  });

  test("the settings page carries reconciliation health on a phone", async ({ page }) => {
    await page.goto("/accounting/quickbooks");
    // `exact` matters here: Playwright matches an accessible name as a case-insensitive substring
    // by default, and since ELEC-236 this page also carries an `h2` reading "QuickBooks connection
    // is turned off". Without it the locator resolves to two headings and dies on strict mode
    // before asserting anything (ELEC-249). The page title is what this line is about, so pin it.
    await expect(
      page.getByRole("heading", { name: "QuickBooks connection", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reconciliation health" })).toBeVisible();
    await expect(page.getByText("Not re-read recently")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the money desk" })).toBeVisible();

    await assertNoHorizontalScroll(page, "quickbooks settings");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/money-settings.png`, fullPage: true });
  });

  test("the final invoice is clear and fixed on a phone", async ({ page }) => {
    await page.route("**/api/v1/quickbooks/final-invoices/**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: quickBooksFinalInvoiceFixture() });
    });

    await page.goto("/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0001");
    await expect(page.getByRole("heading", { name: "CAD 1050.00" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Immutable candidate" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Immutable pre-tax lines" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Why this review is required" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Evidence citations" })).toBeVisible();
    await expect(page.getByText("Aug 13, 2026")).toBeVisible();
    await expect(page.getByText(/Frappe:/).first()).toBeHidden();
    // The candidate above is always readable. The decision below is not, and that is the product
    // behaviour rather than a defect: `QB_FINAL_INVOICE_ENABLED` is off in the committed reference
    // configuration, which ELEC-232 verified and `FIXTURE_CAPABILITY_REFERENCE` in
    // `app/scripts/acceptance-server.mjs` mirrors on purpose. ELEC-236 then made the page withhold
    // an approval it could never execute instead of offering one that would fail.
    //
    // These two lines used to expect "Approve external invoice" and "Reject" to be visible. They
    // were written before that landed and have failed on every run since; ELEC-249 read the
    // symptom as a missing button, but no product code is wrong — the expectation was stale, so it
    // is corrected here rather than deleted (ELEC-251). Asserting the off state is the stronger
    // claim for the configuration we actually ship: the money screen cannot offer an action that
    // has nowhere to go. The enabled decision path stays unproven end to end at phone width, and
    // §8 of the operations annex says so; proving it needs an acceptance mode that serves a
    // switched-on capability, which is new harness scope and belongs under G2.
    await expect(
      page.getByRole("heading", { name: "QuickBooks final-invoice execution is turned off" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Decision unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve external invoice" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);

    await assertNoHorizontalScroll(page, "final invoice");
    await assertActionsAreReachable(page, "final invoice");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/final-invoice.png`, fullPage: true });
  });

  test("the accounting role's navigation reaches every money screen", async ({ page }) => {
    await page.goto("/accounting");
    const nav = page.getByRole("navigation", { name: "Main navigation" }).last();
    await expect(nav.getByRole("link", { name: "Money" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Issues" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();

    await nav.getByRole("link", { name: "Issues" }).click();
    await expect(page.getByRole("heading", { name: "Money issues", exact: true })).toBeVisible();
    await assertNoHorizontalScroll(page, "navigation");
  });
});
