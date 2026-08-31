import { mkdir } from "node:fs/promises";

import { devices, expect, test, type Page } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";

// Mobile acceptance for honest unavailable-capability presentation (ELEC-236, G1.7).
//
// The proof that each capability renders its real state is the component suite in
// `src/capabilities/`. What these add is the half a rendering test cannot: that the honest state
// fits a contractor's phone, that the control it explains is genuinely not tappable, and that the
// answer to "why is this off" is never a link into the Frappe administration interface.
//
// The acceptance server answers `GET /api/v1/capabilities` with the states the committed
// `workers-bus/wrangler.jsonc` really produces, so these screenshots are the reference
// deployment's own answer rather than a staged one.

const SHOT_DIR = ".playwright-mobile";
/** Pixel 5 is the project's mobile profile; 393 px is a common real contractor phone width. */
const MOBILE_WIDTH = 393;

test.use({ ...devices["Pixel 5"] });

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

/**
 * Every control the screen offers stays inside the viewport and keeps a thumb-sized target —
 * including a disabled one. A disabled control still occupies layout, and shrinking it would make
 * the switched-on state jump when an administrator finally turns the capability on.
 */
async function assertControlsAreReachable(page: Page, screen: string): Promise<void> {
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
    // 43.9 rather than 44: a `min-h-11` control measures 43.99998 after the device pixel ratio.
    expect(box.height, `${screen}: "${label}" is only ${box.height}px tall`).toBeGreaterThanOrEqual(
      43.9,
    );
  }
}

async function proveState(page: Page, screen: string): Promise<void> {
  await assertNoHorizontalScroll(page, screen);
  await assertControlsAreReachable(page, screen);
  await assertNoFrappeDesk(page);
  await page.screenshot({ path: `${SHOT_DIR}/capability-${screen}.png`, fullPage: true });
}

test.beforeAll(async () => {
  await mkdir(SHOT_DIR, { recursive: true });
});

test.describe("Unavailable capabilities on an accounting phone", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "accounting", "requires ACCEPTANCE_MODE=accounting");

  test("QuickBooks reads as switched off, with a next step and no connect button that would fail", async ({
    page,
  }) => {
    await page.goto("/accounting/quickbooks");

    await expect(
      page.getByRole("heading", { name: "QuickBooks connection is turned off" }),
    ).toBeVisible();
    await expect(page.getByText("Turned off", { exact: true })).toBeVisible();
    await expect(page.getByText("Next step", { exact: true })).toBeVisible();
    await expect(page.getByText("Who to ask", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect QuickBooks" })).toHaveCount(0);
    // Nothing here is a failure, so nothing offers to try again.
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

    await proveState(page, "quickbooks-off");
    // The panel on its own, at phone width, which is what the annex gallery entry shows.
    // Regenerate with `npm run test:pwa:capabilities:accounting --prefix app` and copy
    // `.playwright-mobile/capability-quickbooks-off-panel.png` over the committed image.
    const panel = page
      .locator('[aria-live="polite"]')
      .filter({ hasText: "QuickBooks connection is turned off" });
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: `${SHOT_DIR}/capability-quickbooks-off-panel.png` });
  });
});

test.describe("Unavailable capabilities on an office phone", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "requires ACCEPTANCE_MODE=estimator");

  test("the desktop pairing button is disabled and says why, at full thumb size", async ({
    page,
  }) => {
    await page.route("**/api/v1/field-users", async (route) => {
      await route.fulfill({
        json: {
          users: [
            {
              id: "appu_crew",
              display_name: "Crew One",
              email: "crew@example.invalid",
              frappe_user_id: null,
            },
          ],
        },
      });
    });
    await page.route("**/api/v1/device-pairings", async (route) => {
      await route.fulfill({ json: { devices: [] } });
    });

    await page.goto("/settings/devices");

    await expect(
      page.getByRole("heading", { name: "Hermes desktop pilot is turned off" }),
    ).toBeVisible();
    const issue = page.getByRole("button", { name: "Issue desktop pairing link" });
    await expect(issue).toBeVisible();
    await expect(issue).toBeDisabled();

    await proveState(page, "hermes-desktop-off");
  });

  test("an unfinished Facet setup does not look like an empty list", async ({ page }) => {
    await page.route("**/api/v1/facet-design-evidence", async (route) => {
      await route.fulfill({
        json: {
          version: 2,
          read_model_generated_at: "2026-08-31T00:00:00.000Z",
          permissions: ["facet:read"],
          allowed_actions: ["facet_design.read"],
          evidence: [],
          intake_exceptions: [],
        },
      });
    });

    await page.goto("/facet-designs");

    await expect(
      page.getByRole("heading", { name: "Facet design delivery is not set up yet" }),
    ).toBeVisible();
    await expect(page.getByText("Setup not finished", { exact: true })).toBeVisible();
    await expect(page.getByText("No signed Facet decisions yet")).toHaveCount(0);

    await proveState(page, "facet-design-unconfigured");
  });

  test("reachability and proof stay two labelled answers on the integrations screen", async ({
    page,
  }) => {
    await page.route("**/api/v1/integrations/readiness*", async (route) => {
      await route.fulfill({
        json: {
          version: 1,
          tenant_id: "ironwrap",
          read_model_generated_at: "2026-08-31T00:00:00.000Z",
          allowed_actions: ["integrations.readiness.read"],
          configuration_mutations_available: false,
          profile: {
            key: "reference_journey",
            version: 3,
            state: "blocked",
            blockers: [],
            dependencies: [],
          },
          capabilities: [
            {
              id: "newo",
              required: true,
              state: "blocked",
              last_proof_at: null,
              proof_expires_at: null,
              fallback: "Answer the phone.",
              blockers: ["manifest_disabled"],
              manifest: null,
            },
            {
              id: "email_delivery",
              required: true,
              state: "ready",
              last_proof_at: null,
              proof_expires_at: null,
              fallback: null,
              blockers: [],
              manifest: null,
            },
          ],
          verdict: "blocked",
        },
      });
    });

    await page.goto("/settings/integrations");

    await expect(page.getByRole("heading", { name: "Integration readiness" })).toBeVisible();
    // "Safely disabled" is what this page's own nav entry already promised and did not keep.
    await expect(page.getByLabel("Newo safely disabled")).toBeVisible();
    await expect(
      page.getByText("1 deliberately switched off, and not counted above."),
    ).toBeVisible();
    // The other question, said to be the other question.
    await expect(page.getByRole("heading", { name: "Capability availability" })).toBeVisible();
    await expect(page.getByText(/A different question from the proof above/)).toBeVisible();

    await proveState(page, "integration-readiness-disabled");
  });
});
