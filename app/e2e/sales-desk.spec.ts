import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

const salesModel = {
  version: 1,
  source_updated_at: "2026-07-11T12:00:00.000Z",
  read_model_generated_at: "2026-07-11T12:00:01.000Z",
  stale_fields: [],
  permissions: ["sales:read"],
  allowed_actions: ["sales.read", "approval.read", "approval.prepare", "estimator.read"],
  partial_sources: [],
  summary: {
    listed_leads: 1,
    triage_unresolved: 1,
    estimate_needs_review: 1,
    quote_needs_review: 1,
    quote_expired: 0,
    no_linked_consent_record: 0,
  },
  leads: [
    {
      id: "LEAD-A",
      envelope_id: "lead_a",
      source: "website",
      received_at: "2026-07-11T12:00:00.000Z",
      transport_status: "received",
      intent_queue: "Estimator",
      contact: {
        display_name: "Pat Prospect",
        phone: "+14035559999",
        email: "pat@example.com",
      },
      triage: {
        status: "Untriaged",
        summary: "Confirm the visit time before a final scope.",
      },
      job: {
        id: "JOB-A",
        job_number: "IW-1001",
        status: "Proposal",
        service_type: "Roofing",
        workflow_profile: "Residential Retail",
      },
      estimate: {
        id: "estimate_a",
        status: "Needs Review",
        service_type: "Roofing",
        range_low: 12400,
        range_high: 15900,
        estimate_total: null,
        confidence: "Preliminary",
        review_required: true,
        reviewed_at: null,
        approved_at: null,
        assumptions: "Roof pitch still needs a check.",
        exclusions: "No final contract.",
      },
      quote: {
        id: "quote_a",
        version: 2,
        status: "Needs Review",
        quote_total: 14750,
        currency: "CAD",
        valid_until: "2026-07-20",
        payment_status: "Not Due",
        prepared_at: "2026-07-11T12:00:00.000Z",
        approved_at: null,
        accepted_at: null,
        scope_summary: "Replace the roof system.",
      },
      proposal: {
        id: "pack_a",
        status: "Draft",
        prepared_at: "2026-07-11T12:00:00.000Z",
        approved_at: null,
        signed_at: null,
        has_published_pack: false,
        published_status: null,
      },
      consent: {
        context: "recorded",
        records: [
          {
            id: "consent_a",
            channel: "Email",
            purpose: "Estimate Follow-up",
            status: "Granted",
            jurisdiction: "AB",
            basis: "Express",
            captured_at: "2026-07-11T12:00:00.000Z",
            effective_from: "2026-07-11T12:00:00.000Z",
            expires_at: null,
            revoked_at: null,
          },
        ],
      },
      attention: ["triage_unresolved", "estimate_needs_review", "quote_needs_review"],
    },
  ],
};

test.describe("Sales desk acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps sales work clear, safe, and usable at every viewport", async ({ page }, testInfo) => {
    await page.route("**/api/v1/sales", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(salesModel),
      }),
    );

    await page.goto("/sales");

    await expect(page.getByRole("heading", { name: "Sales desk" })).toBeVisible();
    await expect(page.getByText("Lead check needed", { exact: true })).toBeVisible();
    await expect(page.getByText("Not final", { exact: true })).toBeVisible();
    await expect(page.getByText("Customer view", { exact: true })).toBeVisible();
    await expect(page.getByText("Not shown to customer", { exact: true })).toBeVisible();
    await expect(page.getByText("lead_a", { exact: true })).toBeHidden();

    const leadCheck = page.getByRole("link", { name: "Start lead check" });
    const roofWork = page.getByRole("link", { name: "Open roof work" });
    await expect(leadCheck).toHaveAttribute("href", "/sales/leads/LEAD-A/triage");
    await expect(roofWork).toHaveAttribute("href", "/estimator/jobs/JOB-A");
    expect((await leadCheck.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((await roofWork.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expect(
      page.getByRole("button", { name: /send|call|email|issue quote|collect payment/i }),
    ).toHaveCount(0);

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);

    await page.screenshot({ path: `${shotDir}/sales-desk-${testInfo.project.name}.png` });

    await page.getByText("System details").click();
    await expect(page.getByText("lead_a", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "Pat Prospect" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shotDir}/sales-lead-${testInfo.project.name}.png` });
  });
});
