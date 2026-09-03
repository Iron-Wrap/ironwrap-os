import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"] as const;

function gates(blocked = false) {
  return gateNames.map((name) => ({
    name,
    state: blocked && name === "Materials" ? "Blocked" : "Ready",
  }));
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
    active_jobs: 2,
    blocked: 1,
    scheduled: 0,
    needs_assignment: 0,
    ready_for_review: 1,
    needs_verification: 0,
  },
  jobs: [
    {
      id: "JOB-A",
      job_number: "IW-1001",
      brand: "IronWrap Exteriors",
      service_type: "Roofing",
      status: "In Production",
      version: 1,
      assignment: {
        id: "assignment:JOB-A",
        type: "Production",
        status: "Blocked",
        assignment_version: 1,
        roof_job_version: 1,
        crew_id: "crew:install",
        crew_version: 1,
        scheduled_start: null,
        scheduled_end: null,
      },
      lane: "blocked",
      scheduling_preparation_allowed: false,
      next_action: "Review the source-backed operational condition",
      gate_coverage: "complete",
      gate_summary: { expected: 6, blocked: 1, ready: 5, waived: 0, done: 0 },
      scheduling_gates: gates(true),
      material_attention: [{ status: "Shortage", requested_delivery_date: null }],
    },
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

test.describe("Production plan acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows safe job work without changing server rules", async ({ page }, testInfo) => {
    await page.route("**/api/v1/production", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(productionModel),
      }),
    );

    await page.goto("/production");

    await expect(page.getByRole("heading", { name: "Production plan" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Work stopped" })).toBeVisible();
    await expect(page.getByText("Shortage · Asked for: date not found")).toBeVisible();
    await expect(page.getByText("JOB-A", { exact: true })).toBeHidden();

    const jobLink = page.getByRole("link", { name: "Open IW-1001" });
    // KNOWN FAILING — owner ELEC-239, recorded 2026-08-31 (PO decision on ELEC-233/G1).
    //
    // IW-1004 sits in "Ready to check" with six ready gates and
    // `scheduling_preparation_allowed: true`, and the app offers no route to a schedule check at
    // all: `production-runway-page.tsx` renders only "Open job", nothing reads
    // `scheduling_preparation_allowed`, and no `/production/schedule/$jobId` route exists. The
    // successor API `POST /api/v1/jobs/{job}/schedule` shipped and is unit-tested; its UI half
    // never did.
    //
    // The disposition is UI defect, not stale test. The repair needs a destination screen that
    // does not exist yet — new product behaviour, owned by ELEC-239 under G3 — so this assertion
    // stays red on purpose. Deleting, skipping or inverting it to assert the affordance's absence
    // would encode the gap as intended behaviour and destroy the only signal pointing at it.
    // The absence assertion in `src/production/production-runway-page.test.tsx` is about the
    // *retired* approval-era affordance and is a different claim; the two agree.
    const scheduleLink = page.getByRole("link", { name: "Start schedule check for IW-1004" });
    await expect(jobLink).toHaveAttribute("href", "/jobs/JOB-A");
    await expect(scheduleLink).toHaveAttribute("href", "/production/schedule/JOB-D");
    await expectTouchTarget(jobLink, { name: "job link", axis: "height" });
    await expectTouchTarget(scheduleLink, { name: "schedule-check link", axis: "height" });
    await expect(page.getByRole("button", { name: /schedule|dispatch/i })).toHaveCount(0);

    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);

    await page.screenshot({ path: `${shotDir}/production-plan-${testInfo.project.name}.png` });

    await page.getByText("System details").first().click();
    await expect(page.getByText("JOB-A", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "Work stopped" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shotDir}/production-stopped-${testInfo.project.name}.png` });
  });
});
