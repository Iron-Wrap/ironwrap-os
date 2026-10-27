import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

const noLeadProof = {
  received_at: null,
  bus_status: null,
  triage_status: null,
  mctb: null,
};

const ownerNow = {
  version: 1,
  source_updated_at: "2026-07-18T15:00:00.000Z",
  read_model_generated_at: "2026-07-18T15:01:00.000Z",
  stale_fields: [],
  permissions: ["owner.now.read"],
  allowed_actions: ["job.read"],
  exceptions: [
    {
      id: "gate:e2e-001",
      kind: "blocked_gate",
      severity: "high",
      title: "Material drop is not confirmed",
      why: "The crew cannot start until the shingles are on site.",
      next_action: null,
      job_id: "IW-2042",
      occurred_at: "2026-07-18T14:55:00.000Z",
      due_at: "2026-07-18T15:30:00.000Z",
      ...noLeadProof,
    },
    {
      id: "lead:e2e-001",
      kind: "untriaged_lead",
      severity: null,
      title: "New lead: Maya",
      why: "Maya asked for a roof visit.",
      next_action: null,
      job_id: null,
      occurred_at: "2026-07-18T15:00:00.000Z",
      due_at: null,
      received_at: "2026-07-18T15:00:00.000Z",
      bus_status: "pushed",
      triage_status: "Untriaged",
      mctb: {
        state: "provider_accepted_within_sla",
        deadline_at: "2026-07-18T15:01:00.000Z",
        observed_at: "2026-07-18T15:00:20.000Z",
        channel: "email",
        proof_kind: "provider_receipt",
      },
    },
  ],
  partial_sources: [],
  summary: {
    active_jobs: 6,
    field_blockers: 0,
    blocked_gates: 1,
    open_incidents: 0,
    finance_exceptions: 0,
    untriaged_leads: 1,
    lead_triage_unknown: 0,
    mctb_unproven_due: 0,
    material_exceptions: 0,
  },
};

const systemCheck = {
  version: 1,
  read_model_generated_at: "2026-07-18T15:02:00.000Z",
  status: "attention",
  readiness: {
    status: "not_ready",
    checks: [
      { id: "owned_persistence", ok: true },
      { id: "queue", ok: true },
      { id: "core_auth", ok: true },
      { id: "provider_delivery", ok: true },
      { id: "office_bff", ok: false },
      { id: "customer_portal", ok: true },
      { id: "production_schedule", ok: true },
      { id: "public_estimate", ok: true },
      { id: "newo", ok: true },
    ],
  },
  operations: {
    status: "degraded",
    heartbeat: null,
    counts: {
      open_dead_letters: 1,
      pending: 0,
      stuck: 0,
      frappe_errors: 0,
      replay_failed: 0,
      replay_stuck: 0,
    },
    audit_failures_observed: 0,
    audit_failure_window_hours: 24,
    quickbooks_receipts: {
      available: false,
      fresh: null,
      age_seconds: null,
      events_count: null,
      replay_count: null,
    },
  },
};

test.describe("Owner now acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows owner work first and keeps system counts closed", async ({ page }, testInfo) => {
    await page.route("**/api/v1/owner/now", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerNow),
      }),
    );
    await page.route("**/api/v1/owner/measurement-intake-exceptions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ measurements: [] }),
      }),
    );
    await page.route("**/api/v1/owner/runtime", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(systemCheck),
      }),
    );

    await page.goto("/owner");
    await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Work stopped" })).toBeVisible();
    await expect(page.getByText("Runtime truth")).toHaveCount(0);
    await expect(page.getByText("Acknowledgement evidence")).toHaveCount(0);
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    const skipBoxBefore = await skipLink.boundingBox();
    expect((skipBoxBefore?.y ?? 0) + (skipBoxBefore?.height ?? 0)).toBeLessThanOrEqual(0);

    await page.screenshot({ path: `${shotDir}/owner-now-${testInfo.project.name}.png` });

    await page.getByRole("button", { name: "Run system check" }).click();
    await expect(page.getByText("Items to fix")).toBeVisible();
    await expect(page.getByText("Messages not finished")).toBeHidden();
    const skipBoxAfter = await skipLink.boundingBox();
    expect((skipBoxAfter?.y ?? 0) + (skipBoxAfter?.height ?? 0)).toBeLessThanOrEqual(0);

    const jobLink = page.getByRole("link", { name: "See job IW-2042" });
    await expect(jobLink).toHaveAttribute("href", "/jobs/IW-2042");
    await expectTouchTarget(jobLink, { name: "See job IW-2042", axis: "height" });

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);

    await page.getByRole("heading", { name: "System check" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shotDir}/owner-now-system-${testInfo.project.name}.png` });
  });
});
