import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"] as const;

function gates() {
  return gateNames.map((name) => ({ name, state: "Ready" }));
}

const productionModel = {
  version: 1,
  source_updated_at: "2026-07-16T12:00:00.000Z",
  read_model_generated_at: "2026-07-16T12:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: [
    "job.read",
    "production.read",
    "production_schedule_approval.prepare",
    "operating_job_assignment.create",
  ],
  partial_sources: [],
  summary: {
    active_jobs: 1,
    blocked: 0,
    scheduled: 0,
    needs_assignment: 0,
    ready_for_review: 1,
    needs_verification: 0,
  },
  jobs: [
    {
      id: "JOB-D",
      job_number: "IW-1004",
      brand: "IronWrap Exteriors",
      service_type: "Roofing",
      status: "Ready",
      version: 1,
      assignment: {
        id: "assignment:JOB-D",
        type: "Production",
        status: "Assigned",
        assignment_version: 1,
        roof_job_version: 1,
        crew_id: "crew:install",
        crew_version: 1,
        scheduled_start: null,
        scheduled_end: null,
      },
      lane: "ready_for_review",
      scheduling_preparation_allowed: true,
      next_action: "Review for scheduling; this view does not dispatch work",
      gate_coverage: "complete",
      gate_summary: { expected: 6, blocked: 0, ready: 6, waived: 0, done: 0 },
      scheduling_gates: gates(),
      material_attention: [],
    },
  ],
  crews: [{ id: "crew:install", name: "Install team", version: 1 }],
};

test.describe("Production schedule check acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the start-date ask on the current production schedule form", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/production", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(productionModel),
      }),
    );

    await page.goto("/production/schedule/JOB-D");

    await expect(page.getByRole("heading", { name: "Schedule production job" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "IW-1004" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record schedule" })).toBeVisible();

    await page.screenshot({
      path: `${shotDir}/production-schedule-${testInfo.project.name}.png`,
      fullPage: true,
    });

    for (const [role, name] of [
      ["link", "Back to production runway"],
      ["button", "Record schedule"],
    ] as const) {
      const box = await page.getByRole(role, { name }).first().boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  });

  test("shows a calm conflict when the same schedule already exists", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/production", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(productionModel),
      }),
    );
    await page.route("**/api/v1/jobs/**/schedule", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "idempotency_conflict",
            message: "This same schedule was already recorded with different details.",
          }),
        });
      }
      return route.fallback();
    });

    await page.goto("/production/schedule/JOB-D");
    await expect(page.getByRole("heading", { name: "Schedule production job" })).toBeVisible();
    await page.getByLabel("Crew").selectOption("crew:install");
    await page.getByLabel("Scheduled start").fill("2026-07-20T09:30");
    await page.getByLabel("Correction reason").fill("Weather moved the install window.");
    await page.getByRole("button", { name: "Record schedule" }).click();

    await expect(page.getByRole("alert")).toContainText("already recorded with different details");
    await expect(page.getByText("Schedule was not recorded")).toBeVisible();
    await expect(page.getByText("idempotency_conflict")).toHaveCount(0);

    await page.screenshot({
      path: `${shotDir}/production-schedule-conflict-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  const approvalId = "production-schedule-approval:e2e-001";

  function scheduleApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: approvalId,
      kind: "production_schedule",
      state: "pending",
      version: 1,
      action: "create_job_assignment",
      roof_job_id: "JOB-D",
      target: { doctype: "Job Assignment", assignment_id: "assignment:JOB-D" },
      crew_profile_id: "crew:install",
      scheduled_start: "2026-07-20T14:00:00.000Z",
      scheduled_end: null,
      supersedes_assignment_id: null,
      correction_reason: null,
      request_text: "Schedule the active production job with the selected crew.",
      preview: {
        would_write: false,
        append_only: true,
        target: { doctype: "Job Assignment", assignment_id: "assignment:JOB-D" },
        assignment: {
          assignment_id: "assignment:JOB-D",
          roof_job_id: "JOB-D",
          crew_profile_id: "crew:install",
          scheduled_start: "2026-07-20T14:00:00.000Z",
          scheduled_end: null,
          supersedes_assignment_id: null,
          correction_reason: null,
        },
        production_schedule_gate_preview: { required: true, state_eligible: true },
        effects: {
          crew_notified: false,
          customer_notified: false,
          accounting_mutated: false,
        },
      },
      expires_at: "2026-07-20T13:00:00.000Z",
      requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
      approved_by: null,
      rejection_reason: null,
      run_id: "run:production-schedule:e2e-001",
      hermes_run_id: null,
      outcome: null,
      error_code: null,
      refusal_message: null,
      reconciliation: null,
      created_at: "2026-07-19T12:00:00.000Z",
      updated_at: "2026-07-19T12:00:00.000Z",
      completed_at: null,
      ...overrides,
    };
  }

  function detailEnvelope(approval: Record<string, unknown>, allowedActions: string[]) {
    return {
      version: 1,
      read_model_generated_at: "2026-07-20T12:00:00.000Z",
      permissions: ["production:read"],
      allowed_actions: allowedActions,
      approval,
    };
  }

  async function openScheduleApproval(
    page: import("@playwright/test").Page,
    approval: Record<string, unknown>,
    allowedActions: string[],
    onPost?: (kind: "approve" | "reject" | "reconcile", body: unknown) => Record<string, unknown>,
  ) {
    await page.route("**/api/v1/production", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(productionModel),
      }),
    );
    let current = approval;
    await page.route("**/api/v1/production-schedule-approvals/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (method === "POST" && onPost) {
        const kind = url.includes("/approve")
          ? "approve"
          : url.includes("/reject")
            ? "reject"
            : "reconcile";
        const body = route.request().postDataJSON() as unknown;
        current = onPost(kind, body);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ approval: current }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailEnvelope(current, allowedActions)),
      });
    });

    await page.goto(`/production/schedule-approvals/${encodeURIComponent(approvalId)}`);
    await expect(page.getByRole("heading", { name: "Crew assignment request" })).toBeVisible();
    await expect(page.getByText("IW-1004")).toBeVisible();
    await expect(page.getByText("Install team")).toBeVisible();
    await expect(page.getByText("Hermes")).toHaveCount(0);
    await expect(page.getByText("JOB-D", { exact: true })).toBeHidden();
    await expect(page.getByText("assignment:JOB-D")).toBeHidden();
    await expect(page.getByText("crew:install")).toBeHidden();
    await expect(page.getByText("2026-07-20T14:00:00.000Z")).toBeHidden();
    await expect(page.getByText("run:production-schedule:e2e-001")).toBeHidden();
    await expect(page.getByText("create_job_assignment")).toHaveCount(0);
  }

  test("approves a schedule request without Hermes or raw codes in the first view", async ({
    page,
  }, testInfo) => {
    const pending = scheduleApproval();
    const executed = scheduleApproval({
      state: "executed",
      version: 2,
      hermes_run_id: "run:production-schedule:e2e-001",
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2026-07-20T12:01:00.000Z",
      },
      outcome: {
        run_id: "run:production-schedule:e2e-001",
        created: true,
        assignment_id: "assignment:JOB-D",
        roof_job_id: "JOB-D",
        crew_profile_id: "crew:install",
        scheduled_start: "2026-07-20T14:00:00.000Z",
        scheduled_end: null,
        supersedes_assignment_id: null,
        audit_finalized: true,
        crew_notified: false,
        customer_notified: false,
        accounting_mutated: false,
      },
    });

    await openScheduleApproval(
      page,
      pending,
      [
        "production_schedule_approval.read",
        "production_schedule_approval.approve",
        "production_schedule_approval.reject",
      ],
      (kind) => {
        expect(kind).toBe("approve");
        return executed;
      },
    );

    await page.getByRole("button", { name: "Approve crew assignment" }).click();
    await expect(page.getByText("The crew assignment is saved.")).toBeVisible();
    await expect(page.getByText("Hermes")).toHaveCount(0);
    await expect(page.getByText("JOB-D", { exact: true })).toBeHidden();

    await page.screenshot({
      path: `${shotDir}/production-schedule-approve-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("JOB-D", { exact: true })).toBeVisible();
    await expect(page.getByText("assignment:JOB-D")).toBeVisible();
  });

  test("rejects a schedule request with a reason and a stable decision key", async ({
    page,
  }, testInfo) => {
    const pending = scheduleApproval();
    const denied = scheduleApproval({
      state: "denied",
      version: 2,
      rejection_reason: "Weather window is wrong.",
    });
    let rejectBody: { version?: number; reason?: string } | undefined;

    await openScheduleApproval(
      page,
      pending,
      [
        "production_schedule_approval.read",
        "production_schedule_approval.approve",
        "production_schedule_approval.reject",
      ],
      (kind, body) => {
        expect(kind).toBe("reject");
        rejectBody = body as { version?: number; reason?: string };
        return denied;
      },
    );

    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByLabel("Why should this request be rejected?").fill("Weather window is wrong.");
    await page.getByRole("button", { name: "Reject request" }).click();

    await expect(page.getByText("The request was rejected.")).toBeVisible();
    await expect(page.getByText("Not approved")).toBeVisible();
    await expect(page.getByText("Weather window is wrong.")).toBeVisible();
    expect(rejectBody).toEqual({ version: 1, reason: "Weather window is wrong." });
    await expect(page.getByText("Hermes")).toHaveCount(0);

    await page.screenshot({
      path: `${shotDir}/production-schedule-reject-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("reconciles an uncertain schedule outcome without a retry", async ({ page }, testInfo) => {
    const uncertain = scheduleApproval({
      state: "execution_uncertain",
      version: 3,
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2026-07-20T12:01:00.000Z",
      },
      hermes_run_id: "run:production-schedule:e2e-001",
      error_code: "broker_response_unverified",
    });
    const reconciled = {
      ...uncertain,
      version: 4,
      reconciliation: {
        at: "2026-07-20T12:02:00.000Z",
        by_user_id: "appu_owner",
        by_frappe_user: "owner@ironwrapexteriors.com",
        outcome: "inconclusive",
        evidence: "Checked the saved record; no second assignment is needed.",
      },
    };

    await openScheduleApproval(
      page,
      uncertain,
      ["production_schedule_approval.read", "production_schedule_approval.reconcile"],
      (kind, body) => {
        expect(kind).toBe("reconcile");
        expect(body).toEqual({
          version: 3,
          outcome: "inconclusive",
          evidence: "Checked the saved record; no second assignment is needed.",
        });
        return reconciled;
      },
    );

    await expect(page.getByText("Do not retry this request")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve crew assignment" })).toHaveCount(0);
    await page.getByRole("button", { name: "Reconcile recorded outcome" }).click();
    await page
      .getByLabel("Reconciliation evidence")
      .fill("Checked the saved record; no second assignment is needed.");
    await page.getByRole("button", { name: "Record reconciliation" }).click();

    await expect(page.getByText("Reconciliation recorded: Inconclusive")).toBeVisible();
    await expect(page.getByText("Hermes")).toHaveCount(0);
    await expect(page.getByText("broker_response_unverified")).toBeHidden();

    await page.screenshot({
      path: `${shotDir}/production-schedule-reconcile-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("broker_response_unverified")).toBeVisible();
  });
});
