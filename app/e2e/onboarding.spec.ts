import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";
import { expectTouchTarget } from "./touch-target";

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
    "main button:visible, main a:visible, main select:visible, main input:not(.sr-only):not([type=radio]):not([type=checkbox]):visible, main .new-lead-choice:visible, main .new-lead-consent:visible",
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
    await expectTouchTarget(control, { name: `${screen}: "${label}"`, axis: "height" });
  }
}

async function assertAxeClean(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
}

/** Sam Sales on the list, his access open on this screen. */
async function openSam(page: Page): Promise<void> {
  await page.goto("/settings/team");
  await page.getByLabel("Their name").fill("Sam Sales");
  await page.getByLabel("Their work email").fill("sam@freshco.example");
  await page.getByRole("button", { name: "Add to the company" }).click();
  await expect(page.getByText("Sam Sales can sign in now")).toBeVisible();
  await page.getByRole("button", { name: "See access for Sam Sales" }).click();
}

/** The same owner changes Sam's access on another tab first. */
async function onAnotherTab(
  context: BrowserContext,
  change: (other: Page) => Promise<void>,
): Promise<void> {
  const other = await context.newPage();
  await other.goto("/settings/team");
  await other.getByRole("button", { name: "See access for Sam Sales" }).click();
  await change(other);
  await other.close();
}

async function changeRoleTo(other: Page, role: RegExp, saved: string): Promise<void> {
  await other.getByRole("radio", { name: role }).check();
  await other.getByRole("button", { name: "Save Sam’s access" }).click();
  await expect(other.getByText(saved)).toBeVisible();
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
    const customerView = page.getByRole("region", { name: "What customers see now" });
    await expect(customerView).toContainText("Phone: +1 780-555-0134");

    // A local number with no country on file is withheld from customers, and the owner is told.
    await page.getByLabel("Phone").fill("780 555 0134");
    await page.getByRole("button", { name: "Save company details" }).click();
    await expect(customerView.getByText("Customers will not see your phone")).toBeVisible();
    await page.screenshot({
      path: `${SHOT_DIR}/onboarding-02b-contact-withheld.png`,
      fullPage: true,
    });
    await page.getByLabel("Phone").fill("+1 780 555 0134");
    await page.getByRole("button", { name: "Save company details" }).click();
    await expect(customerView).toContainText("Phone: +1 780-555-0134");

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
    // The one account a fresh tenant starts with is the owner, and it cannot lock itself out: its
    // row has no controls, only the line.
    await expect(
      page.getByText("Nobody can change their own access.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /access for Ada Owner/ })).toHaveCount(0);

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

    // The same address again: nothing is added, the line says where their access is, no retry.
    await page.getByLabel("Their name").fill("Sam Sales");
    await page.getByLabel("Their work email").fill("sam@freshco.example");
    await page.getByRole("button", { name: "Add to the company" }).click();
    await expect(
      page.getByText("sam@freshco.example is already on your team, so nothing was added."),
    ).toBeVisible();
    await expect(
      page.getByText("To change their access, use “See access” on their row."),
    ).toBeVisible();
    await expect(page.getByLabel("Their work email")).toHaveValue("sam@freshco.example");
    await assertAxeClean(page);
  });

  test("a role change refused because another tab changed the access first reloads and saves", async ({
    page,
    context,
  }) => {
    // This screen decides on Sam's access as it loaded it...
    await openSam(page);
    await page.getByRole("radio", { name: /^Accounting/ }).check();
    const access = page.getByRole("region", { name: "Sam Sales’s access" });
    await expect(access.getByText("Not saved", { exact: true })).toBeVisible();

    // ...while the same owner changes it on another tab first.
    await onAnotherTab(context, (other) =>
      changeRoleTo(other, /^Production/, "Production · sam@freshco.example"),
    );

    // 2 · Conflict: the refusal hands the focus to the reload.
    await page.getByRole("button", { name: "Save Sam’s access" }).click();
    await expect(
      access.getByText(
        "You changed Sam Sales’s access somewhere else a moment ago: their role is now Production, not Sales.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Accounting/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Sales · may be out of date/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reload Sam’s access" })).toBeFocused();
    await assertNoHorizontalScroll(page, "access conflict");
    await assertActionsAreReachable(page, "access conflict");
    await assertAxeClean(page);
    await page.screenshot({
      path: `${SHOT_DIR}/onboarding-05b-access-conflict.png`,
      fullPage: true,
    });

    // 3 · After reload: only a refusal moves the focus, so Save is not pulled into it.
    await page.getByRole("button", { name: "Reload Sam’s access" }).click();
    await expect(
      page.getByRole("radio", { name: /^Production · changed somewhere else a moment ago/ }),
    ).toBeVisible();
    await expect(
      access.getByText(
        "Your change is not saved yet: Sam’s role changes from Production to Accounting.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Sam’s access" })).not.toBeFocused();
    await assertNoHorizontalScroll(page, "access after reload");
    await assertAxeClean(page);
    await page.getByRole("button", { name: "Save Sam’s access" }).click();
    await expect(page.getByText("Accounting · sam@freshco.example")).toBeVisible();
    await expect(access.getByText("Not saved", { exact: true })).toHaveCount(0);
    await assertNoHorizontalScroll(page, "access saved after the reload");
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-05c-access-saved.png`, fullPage: true });
  });

  test("a remove refused because another tab changed the access waits for the reload", async ({
    page,
    context,
  }) => {
    await openSam(page);
    await onAnotherTab(context, (other) =>
      changeRoleTo(other, /^Production/, "Production · sam@freshco.example"),
    );

    // 4 · Held remove plus conflict.
    await page.getByRole("button", { name: "Remove Sam from the team" }).click();
    await expect(page.getByText("Your change: remove Sam from the team. Not saved.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove Sam from the team · after reload" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reload Sam’s access" })).toBeFocused();
    await assertNoHorizontalScroll(page, "held remove");
    await assertActionsAreReachable(page, "held remove");
    await assertAxeClean(page);

    // Reloaded, the held remove is the next step.
    await page.getByRole("button", { name: "Reload Sam’s access" }).click();
    await page.getByRole("button", { name: "Remove Sam from the team", exact: true }).click();
    await expect(page.getByText("No access", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Give Sam access back" })).toBeVisible();
    await assertAxeClean(page);
  });

  test("a role change that cannot apply after another tab removed the person gives access back first", async ({
    page,
    context,
  }) => {
    await openSam(page);
    await page.getByRole("radio", { name: /^Accounting/ }).check();
    await onAnotherTab(context, async (other) => {
      await other.getByRole("button", { name: "Remove Sam from the team" }).click();
      await expect(other.getByRole("button", { name: "Give Sam access back" })).toBeVisible();
    });

    await page.getByRole("button", { name: "Save Sam’s access" }).click();
    await expect(
      page.getByText(
        "You changed Sam Sales’s access somewhere else a moment ago: they no longer have access.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reload Sam’s access" }).click();

    // 5 · No longer possible: reached by a reload, so nothing takes the focus.
    await expect(
      page.getByText(
        "Your change cannot apply: you removed Sam Sales from the team somewhere else a moment ago.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Your change: Sam’s role changes from Sales to Accounting. Not saved."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Give Sam access back" })).not.toBeFocused();
    await expect(
      page.getByRole("button", { name: "Save Sam’s access · after their access is back" }),
    ).toBeDisabled();
    await assertNoHorizontalScroll(page, "cannot apply");
    await assertActionsAreReachable(page, "cannot apply");
    await assertAxeClean(page);

    await page.getByRole("button", { name: "Give Sam access back" }).click();
    await page.getByRole("button", { name: "Save Sam’s access" }).click();
    await expect(page.getByText("Accounting · sam@freshco.example")).toBeVisible();
  });

  test("a reload that fails, or runs offline, keeps the change and offers the reload again", async ({
    page,
    context,
  }) => {
    await openSam(page);
    await page.getByRole("radio", { name: /^Accounting/ }).check();
    await onAnotherTab(context, (other) =>
      changeRoleTo(other, /^Production/, "Production · sam@freshco.example"),
    );
    await page.getByRole("button", { name: "Save Sam’s access" }).click();
    await expect(page.getByRole("button", { name: "Reload Sam’s access" })).toBeFocused();

    // 6a · The list does not answer.
    await page.route("**/api/v1/admin/app-users", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 503, body: '{"error":"unavailable"}' })
        : route.continue(),
    );
    await page.getByRole("button", { name: "Reload Sam’s access" }).click();
    await expect(
      page.getByText(
        "Sam’s access did not reload; your change is kept until you save it or leave this page.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save Sam’s access · after reload" }),
    ).toBeDisabled();
    await expect(page.getByRole("radio", { name: /^Accounting/ })).toBeChecked();
    await assertNoHorizontalScroll(page, "reload failed");
    await assertActionsAreReachable(page, "reload failed");
    await assertAxeClean(page);
    await page.unroute("**/api/v1/admin/app-users");

    // 6b · Offline.
    await context.setOffline(true);
    await page.getByRole("button", { name: "Reload Sam’s access again" }).click();
    await expect(
      page.getByText(
        "You are offline, so Sam’s access cannot reload; your change is kept until you save it or leave this page. When you’re back online, reload their access.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload Sam’s access again" })).not.toBeFocused();
    await assertNoHorizontalScroll(page, "reload offline");
    await assertAxeClean(page);

    // Back online, the reload lands and the change is still waiting for Save.
    await context.setOffline(false);
    await page.getByRole("button", { name: "Reload Sam’s access again" }).click();
    await expect(
      page.getByRole("radio", { name: /^Production · changed somewhere else a moment ago/ }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Accounting/ })).toBeChecked();
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
    await page.getByRole("textbox", { name: "Phone", exact: true }).fill("403-555-0117");
    // A service nobody configured in advance: typed as the customer said it.
    await page.getByLabel(/^Kind of work/).fill("Cedar shake restoration");
    await page.getByLabel(/^City or town/).fill("Edmonton");

    await assertNoHorizontalScroll(page, "add a lead");
    await assertActionsAreReachable(page, "add a lead");
    await page.screenshot({ path: `${SHOT_DIR}/onboarding-07-new-lead.png`, fullPage: true });

    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved lead details" })).toContainText(
      "Grace Green",
    );
    await page.reload();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review this lead" })).toBeVisible();
    await page.getByRole("link", { name: "Sales desk", exact: true }).last().click();
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
