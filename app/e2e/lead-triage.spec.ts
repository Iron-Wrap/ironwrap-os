import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

const salesModel = {
  version: 1,
  source_updated_at: "2026-07-12T12:00:00.000Z",
  read_model_generated_at: "2026-07-12T12:00:01.000Z",
  stale_fields: [],
  permissions: ["sales:read", "approvals:read"],
  allowed_actions: ["sales.read", "commercial.lead_triage.record"],
  partial_sources: [],
  summary: {
    listed_leads: 1,
    triage_unresolved: 1,
    estimate_needs_review: 0,
    quote_needs_review: 0,
    quote_expired: 0,
    no_linked_consent_record: 0,
  },
  leads: [
    {
      id: "LEAD-A",
      envelope_id: "bus-external-reference",
      source: "website",
      received_at: "2026-07-12T12:00:00.000Z",
      transport_status: "received",
      intent_queue: "Estimator",
      contact: {
        display_name: "Pat Prospect",
        phone: "+14035559999",
        email: "pat@example.com",
      },
      triage: { status: "Untriaged", summary: null, version: 1 },
      job: null,
      estimate: null,
      quote: null,
      proposal: null,
      consent: { context: "recorded", records: [] },
      partial_fields: [],
      attention: ["triage_unresolved"],
    },
  ],
};

test.describe("Lead check acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the lead check clear and system IDs out of the first view", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/sales", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(salesModel),
      }),
    );

    await page.goto("/sales/leads/LEAD-A/triage");

    await expect(page.getByRole("heading", { name: "Record native triage" })).toBeVisible();
    await expect(page.getByText("Pat Prospect").first()).toBeVisible();
    await expect(page.getByText("LEAD-A", { exact: true })).toBeHidden();
    await expect(page.getByText("bus-external-reference")).toBeHidden();
    await expect(page.getByText("+14035559999")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Record triage" })).toBeVisible();

    await page.screenshot({
      path: `${shotDir}/lead-check-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("LEAD-A", { exact: true })).toBeVisible();

    for (const [role, name] of [
      ["link", "Back to Sales"],
      ["button", "Refresh context"],
      ["button", "Record triage"],
    ] as const) {
      await expectTouchTarget(page.getByRole(role, { name }).first(), {
        name,
        axis: "height",
      });
    }

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  });
});
