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
  allowed_actions: ["job.read", "production.read", "production_schedule_approval.prepare"],
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
      assignment: {
        id: "assignment:JOB-D",
        type: "Production",
        status: "Assigned",
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
  crews: [{ id: "crew:install", name: "Install team" }],
};

test.describe("Production schedule check acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the start-date ask clear and system IDs out of the first view", async ({
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

    await expect(page.getByRole("heading", { name: "Ask to set a start date" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "IW-1004" })).toBeVisible();
    await expect(page.getByText("JOB-D", { exact: true })).toBeHidden();
    await expect(page.getByText("assignment:JOB-D")).toBeHidden();
    await expect(page.getByRole("button", { name: "Send for a check" })).toBeVisible();

    await page.screenshot({
      path: `${shotDir}/production-schedule-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("JOB-D", { exact: true })).toBeVisible();
    await expect(page.getByText("assignment:JOB-D")).toBeVisible();

    for (const [role, name] of [
      ["link", "Back to the production plan"],
      ["button", "Send for a check"],
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

  test("shows a calm conflict when the same ask already exists", async ({ page }, testInfo) => {
    await page.route("**/api/v1/production", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(productionModel),
      }),
    );
    await page.route("**/api/v1/production-schedule-approvals", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "idempotency_conflict" }),
        });
      }
      return route.fallback();
    });

    await page.goto("/production/schedule/JOB-D");
    await expect(page.getByRole("heading", { name: "Ask to set a start date" })).toBeVisible();
    await page.getByLabel("Crew").selectOption("crew:install");
    await page.getByLabel("Start time").fill("2026-07-20T09:30");
    await page
      .getByLabel("Why replace the saved start date?")
      .fill("Weather moved the install window.");
    await page.getByRole("button", { name: "Send for a check" }).click();

    await expect(page.getByRole("alert")).toContainText("already sent with different details");
    await expect(page.getByText("The start date was not sent")).toBeVisible();
    await expect(page.getByText("idempotency_conflict")).toHaveCount(0);

    await page.screenshot({
      path: `${shotDir}/production-schedule-conflict-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
