import { mkdir } from "node:fs/promises";

import { devices, expect, test, type Page } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";

// Mobile-first acceptance for onboarding v0 (ELEC-160, blockers B1/B3/B4 from ELEC-158).
//
// The delivery promise is that a non-technical owner sets up their own company from the app: name,
// logo, teammates, first lead — no curl call and no JSON file edit. These run the whole of that
// path at a Pixel-class viewport against the `onboarding` acceptance profile, and assert the same
// two mobile gates the money desk suite does:
//
//  1. **No horizontal scrolling.** A setup form that scrolls sideways hides the field the next
//     step depends on.
//  2. **No hidden or thumb-hostile controls.** Every visible control sits inside the viewport and
//     is at least 44 CSS px tall.
//
// Screenshots land in `.playwright-mobile/` and are the evidence attached to the delivery report.

const onboardingMode = process.env.ACCEPTANCE_MODE === "onboarding";
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
  // `.sr-only` inputs are the accessible half of a visible control (the logo file input sits
  // behind its "Upload logo" button); the button is the tap target being measured, not the input.
  const controls = page.locator(
    "main button:visible, main a:visible, main select:visible, main input:not(.sr-only):visible",
  );
  const count = await controls.count();
  expect(count, `${screen} offers no controls at all`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    if (!box) continue;
    const label =
      (await control.getAttribute("aria-label")) ??
      (await control.textContent())?.trim().slice(0, 40) ??
      `control ${index}`;
    expect(box.x, `${screen}: "${label}" starts off the left edge`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${screen}: "${label}" runs past the right edge`).toBeLessThanOrEqual(
      MOBILE_WIDTH + 1,
    );
    // 43.9 rather than 44: a `min-h-11` control measures 43.99998 after the device pixel ratio.
    expect(box.height, `${screen}: "${label}" is only ${box.height}px tall`).toBeGreaterThanOrEqual(
      43.9,
    );
  }
}

test.use({ ...devices["Pixel 5"] });

test.describe("Onboarding v0 mobile acceptance", () => {
  test.skip(!onboardingMode, "requires ACCEPTANCE_MODE=onboarding");

  test.beforeAll(async () => {
    await mkdir(SHOT_DIR, { recursive: true });
  });

  test.beforeEach(async ({ request }) => {
    await request.post("/__acceptance/onboarding/reset");
  });

  test("setup lists what a new company has to do, in order", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();

    await expect(page.getByRole("link", { name: /Company details/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /People/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Crew phones/ })).toBeVisible();
    // The company has not said who it is yet, and the list says so rather than looking finished.
    // "Later" is the current word for that state: PR #165 replaced the old `Set` / `Not set yet`
    // pair computed from `profile.updated_at` with the four-state `done | in_progress | skipped |
    // later` model in `company-setup-store.ts`, which `setup-page.tsx` renders. The locator is
    // scoped to the Company details row on purpose — People and Crew phones read "Later" too on a
    // fresh tenant, so an unscoped match would pass without proving anything about the company.
    await expect(
      page.getByRole("link", { name: /Company details/ }).getByText("Later"),
    ).toBeVisible();
    await expect(page.getByText("0 of 5 setup areas complete.")).toBeVisible();

    await assertNoHorizontalScroll(page, "setup");
    await assertActionsAreReachable(page, "setup");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-01-setup.png`, fullPage: true });
  });

  test("an owner enters their company details and uploads a logo from a phone", async ({
    page,
  }) => {
    await page.goto("/settings/company");
    await expect(page.getByRole("heading", { name: "Company details" })).toBeVisible();

    await page.getByLabel(/^Company name/).fill("FreshCo Exteriors Ltd.");
    await page.getByLabel(/^Short name/).fill("FreshCo");
    await page.getByLabel("What you do and where").fill("Greater Edmonton roofing");
    await page.getByLabel("Phone").fill("+1 780 555 0134");
    await page.getByLabel("Street address").fill("88 Shingle Way");
    await page.getByLabel("City").fill("Edmonton");

    await assertNoHorizontalScroll(page, "company details");
    await assertActionsAreReachable(page, "company details");
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-02-company-form.png`, fullPage: true });

    await page.getByRole("button", { name: "Save company details" }).click();
    await expect(page.getByText("Company details saved")).toBeVisible();

    // The logo: chosen from the phone's own file picker, no config file anywhere in the path.
    await page.getByLabel("Choose a logo file").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.getByAltText("FreshCo Exteriors Ltd. logo")).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace logo" })).toBeVisible();

    await assertNoHorizontalScroll(page, "company details with logo");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-03-company-saved.png`, fullPage: true });
  });

  test("an owner adds a teammate and the list shows who has access", async ({ page }) => {
    await page.goto("/settings/team");
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    // The one account a fresh tenant starts with is the owner, and it cannot lock itself out.
    await expect(page.getByLabel("Role for Ada Owner")).toBeDisabled();

    await page.getByLabel("Their name").fill("Sam Sales");
    await page.getByLabel("Their work email").fill("sam@freshco.example");
    await page.getByLabel("What they can see").selectOption("sales");

    await assertNoHorizontalScroll(page, "people");
    await assertActionsAreReachable(page, "people");
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-04-people-form.png`, fullPage: true });

    await page.getByRole("button", { name: "Add to the company" }).click();
    await expect(page.getByText("Sam Sales can sign in now")).toBeVisible();
    await expect(page.getByText("sam@freshco.example")).toBeVisible();

    await assertNoHorizontalScroll(page, "people after adding");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-05-people-added.png`, fullPage: true });
  });

  test("a fresh sales desk offers the first lead instead of an empty tab", async ({ page }) => {
    await page.goto("/sales");
    await expect(page.getByRole("heading", { name: "Sales desk" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No leads yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a lead" }).first()).toBeVisible();

    await assertNoHorizontalScroll(page, "empty sales desk");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-06-sales-empty.png`, fullPage: true });
  });

  test("the office takes its first lead by hand and it lands on the sales desk", async ({
    page,
  }) => {
    await page.goto("/sales/new-lead");
    await expect(page.getByRole("heading", { name: "Add a lead" })).toBeVisible();

    await page.getByLabel(/^Full name/).fill("Grace Green");
    await page.getByLabel("Phone").fill("403-555-0117");
    // A service nobody configured in advance: typed as the customer said it.
    await page.getByLabel("What they need").fill("Cedar shake restoration");
    await page.getByLabel("City").fill("Edmonton");

    await assertNoHorizontalScroll(page, "add a lead");
    await assertActionsAreReachable(page, "add a lead");
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-07-new-lead.png`, fullPage: true });

    await page.getByRole("button", { name: "Add the lead" }).click();
    await expect(page.getByRole("heading", { name: "Sales desk" })).toBeVisible();
    await expect(page.getByText("Grace Green")).toBeVisible();

    await assertNoHorizontalScroll(page, "sales desk with first lead");
    await assertNoFrappeDesk(page);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-08-first-lead.png`, fullPage: true });
  });

  // The owner's schedule-request entry points are gone from the production plan itself — that is
  // asserted at the component level in `production-runway-page.test.tsx`. What this checks is the
  // other half: the address those buttons used to lead to no longer resolves to a working screen
  // whose API has answered 404 since the IRO-195 D1 cutover (ELEC-157 item 16, PO decision D13).
  test("the retired schedule-request address no longer resolves to a screen", async ({ page }) => {
    await page.goto("/production/schedule-approvals");
    await expect(page.getByText("Not Found")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-09-retired-route.png`, fullPage: true });
  });
});
