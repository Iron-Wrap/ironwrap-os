import { expect, type Page } from "@playwright/test";

/**
 * The ERPNext desk is never an answer for an end user.
 *
 * This lived inside `onboarding.spec.ts`, where it only ever ran against the onboarding flow.
 * Every surface an unavailable capability now explains — QuickBooks, crew devices, reception,
 * marketing, Facet evidence, the estimator workbench, the integrations page — is a place a
 * "configure it in the admin interface" link could appear as the answer to "why is this off",
 * which is exactly the routing this product forbids. So the guard moved here and the surfaces
 * call it (ELEC-236 AC5).
 */
export async function assertNoFrappeDesk(page: Page): Promise<void> {
  const desk = page.locator('a[href*="/app/"], a[href*="/desk"], a[href*="erpnext"]');
  expect(await desk.count(), "a link into the Frappe administration interface is on screen").toBe(
    0,
  );
}
