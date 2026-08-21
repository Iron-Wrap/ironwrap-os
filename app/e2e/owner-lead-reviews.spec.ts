import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

const approval = {
  id: "approval:e2e-001",
  kind: "lead_triage",
  state: "pending",
  version: 1,
  action: "mark_lead_triaged",
  target: { doctype: "Lead Envelope", name: "lead:e2e-001", lead_envelope_id: "lead:e2e-001" },
  request_text: "Save this lead note only after owner review.",
  preview: {
    would_write: false,
    target: { doctype: "Lead Envelope", name: "lead:e2e-001" },
    before: {
      triage_status: "Untriaged",
      triaged_by: null,
      triaged_at: null,
      triage_summary: null,
    },
    patch: {
      triage_status: "Triaged",
      triaged_by: "owner@ironwrapexteriors.com",
      triaged_at: null,
      triage_summary: "Hail report. Check the visit time before calling.",
    },
    transport_status_unchanged: "pushed",
    communication_events_mutated: false,
  },
  expires_at: "2026-07-18T15:15:00.000Z",
  requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
  approved_by: null,
  rejection_reason: null,
  run_id: "run:lead-triage:e2e-001",
  hermes_run_id: null,
  outcome: null,
  error_code: null,
  reconciliation: null,
  created_at: "2026-07-18T15:00:00.000Z",
  updated_at: "2026-07-18T15:00:00.000Z",
  completed_at: null,
};

test.describe("Owner lead review acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows the lead change first and keeps system IDs closed", async ({ page }, testInfo) => {
    await page.route("**/api/v1/approvals*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          read_model_generated_at: "2026-07-18T15:00:00.000Z",
          permissions: ["approvals:read"],
          allowed_actions: ["approval.read", "approval.approve", "approval.reject"],
          approvals: [approval],
        }),
      });
    });

    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: "Lead reviews" })).toBeVisible();
    await expect(page.getByText("What will change")).toBeVisible();
    await expect(page.getByText("lead:e2e-001")).toBeHidden();

    await page.screenshot({
      path: `${shotDir}/owner-lead-reviews-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("lead:e2e-001")).toBeVisible();

    for (const name of ["Load again", "Save lead check", "Turn down"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  });
});
