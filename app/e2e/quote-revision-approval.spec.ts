import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const quoteReviewMode = process.env.ACCEPTANCE_MODE === "estimator";
const approvalId = "quote-revision-approval:e2e-001";
const shotDir = ".playwright-mobile";

const approval = {
  id: approvalId,
  kind: "quote_revision",
  state: "pending",
  version: 1,
  action: "create_quote_revision_draft",
  roof_job_id: "JOB-ESTIMATOR-ACCEPTANCE",
  source: {
    customer_quote_id: "QUOTE-E2E",
    quote_version: 3,
    status: "Needs Review",
    modified: "2026-07-18T15:00:00.000Z",
  },
  target: {
    doctype: "Customer Quote",
    customer_quote_id: "QUOTE-E2E-V4",
    quote_version: 4,
  },
  correction_reason: "Use the new roof size before the next price is set.",
  request_text: "Make an empty draft after a person reviews it.",
  preview: {
    would_write: false,
    append_only: true,
    target: {
      doctype: "Customer Quote",
      customer_quote_id: "QUOTE-E2E-V4",
      quote_version: 4,
    },
    source: {
      customer_quote_id: "QUOTE-E2E",
      quote_version: 3,
      status: "Needs Review",
      modified: "2026-07-18T15:00:00.000Z",
    },
    draft: {
      customer_quote_id: "QUOTE-E2E-V4",
      quote_version: 4,
      status: "Draft",
      supersedes: "QUOTE-E2E",
      correction_reason: "Use the new roof size before the next price is set.",
    },
    observed_quote_count: 1,
    effects: {
      customer_notified: false,
      commercial_terms_copied: false,
      proposal_sent: false,
      accounting_mutated: false,
    },
  },
  expires_at: "2026-07-18T15:15:00.000Z",
  requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
  approved_by: null,
  rejection_reason: null,
  run_id: "run:quote-revision:e2e-001",
  hermes_run_id: null,
  outcome: null,
  error_code: null,
  reconciliation: null,
  created_at: "2026-07-18T15:00:00.000Z",
  updated_at: "2026-07-18T15:00:00.000Z",
  completed_at: null,
};

test.describe("Quote change review acceptance", () => {
  test.skip(!quoteReviewMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the choice clear and system IDs out of the first view", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/quote-revision-approvals/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          read_model_generated_at: "2026-07-18T15:00:00.000Z",
          permissions: ["estimator:read"],
          allowed_actions: [
            "quote_revision_approval.read",
            "quote_revision_approval.approve",
            "quote_revision_approval.reject",
          ],
          approval,
        }),
      });
    });

    await page.goto(`/quote-revision-approvals/${encodeURIComponent(approvalId)}`);
    await expect(page.getByRole("heading", { name: "Review a new quote" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Make the empty draft?" })).toBeVisible();
    await expect(page.getByText("QUOTE-E2E-V4")).toBeHidden();

    await page.screenshot({
      path: `${shotDir}/quote-change-review-${testInfo.project.name}.png`,
      fullPage: true,
    });

    const details = page.getByText("System details");
    await details.click();
    await expect(page.getByText("QUOTE-E2E-V4")).toBeVisible();

    for (const [role, name] of [
      ["button", "Load again"],
      ["link", "Open quote"],
      ["button", "Make empty draft"],
      ["button", "Turn down"],
    ] as const) {
      const box = await page.getByRole(role, { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  });
});
