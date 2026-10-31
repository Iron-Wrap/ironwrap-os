import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const captureDir = process.env.PRODUCTION_D5_CAPTURE_DIR;
const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
const fixture = {
  version: 1,
  source_updated_at: "2026-07-16T12:00:00.000Z",
  read_model_generated_at: "2026-07-16T12:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read"],
  partial_sources: [],
  summary: {
    active_jobs: 1,
    blocked: 1,
    scheduled: 0,
    needs_assignment: 0,
    ready_for_review: 0,
    needs_verification: 0,
  },
  jobs: [
    {
      id: "native-job:synthetic-d5",
      job_number: "IW-SYNTH-D5",
      brand: "IronWrap Exteriors",
      service_type: "Roofing",
      status: "In Production",
      version: 1,
      assignment: null,
      scheduling_preparation_allowed: false,
      lane: "blocked",
      next_action: "Review the source-backed condition",
      gate_coverage: "complete",
      gate_summary: { expected: 6, blocked: 1, ready: 5, waived: 0, done: 0 },
      scheduling_gates: gateNames.map((name) => ({
        name,
        state: name === "Materials" ? "Blocked" : "Ready",
      })),
      material_attention: [{ status: "Shortage", requested_delivery_date: null }],
    },
  ],
  crews: [],
};

const states = ["known", "unknown", "legacy", "long", "malformed"] as const;

test.describe("Production job identity representation", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "requires the synthetic office session");

  for (const state of states) {
    test(`renders the ${state} identity without inferred data or authority`, async ({
      page,
    }, testInfo) => {
      const recordedJob = fixture.jobs[0]!;
      const identity =
        state === "legacy"
          ? {}
          : {
              customer_display_name:
                state === "unknown"
                  ? null
                  : state === "long"
                    ? "Synthetic Customer With A Deliberately Long Recorded Organization Name For Wrapping"
                    : "Synthetic Customer One",
              address:
                state === "unknown"
                  ? null
                  : state === "malformed"
                    ? 42
                    : state === "long"
                      ? "Unit 200 - 100 Very Long Synthetic Example Street, Example Municipality, Alberta, Canada"
                      : "2 - 100 Example Street, Example City, AB",
            };
      const body = {
        ...fixture,
        jobs: [
          {
            ...recordedJob,
            ...identity,
            job_number:
              state === "unknown"
                ? null
                : state === "long"
                  ? "IW-SYNTHETIC-JOB-NUMBER-WITH-A-LONG-RECORDED-SUFFIX-0001"
                  : recordedJob.job_number,
          },
        ],
      };
      const reads: string[] = [];
      await page.route(
        (url) => url.pathname === "/api/v1/production",
        async (route) => {
          const url = new URL(route.request().url());
          reads.push(url.pathname + url.search);
          expect(url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
            headers: { "Cache-Control": "private, no-store" },
          });
        },
      );
      await page.goto("/production");

      if (state === "malformed") {
        await expect(page.getByRole("heading", { name: "Job plan could not load" })).toBeVisible();
        await expect(page.getByText("Synthetic Customer One")).toHaveCount(0);
      } else {
        await expect(page.getByRole("heading", { name: "Production plan" })).toBeVisible();
        await expect(page.getByText("native-job:synthetic-d5", { exact: true })).toBeHidden();
        if (state === "legacy" || state === "unknown") {
          await expect(page.getByText("Customer not recorded")).toBeVisible();
          await expect(page.getByText("Job site not recorded")).toBeVisible();
        } else {
          await expect(
            page.getByText(identity.customer_display_name!, { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(String(identity.address), { exact: true })).toBeVisible();
        }
        await expect(
          page.getByRole("heading", {
            name:
              state === "unknown"
                ? "Job number Not recorded"
                : `Job number ${body.jobs[0]!.job_number}`,
          }),
        ).toBeVisible();
        await expect(page.getByLabel("Materials: Blocked")).toBeVisible();
        await expect(page.getByRole("button", { name: /clear|schedule|dispatch/i })).toHaveCount(0);
      }

      expect(reads).toEqual(["/api/v1/production?include_job_identity=1"]);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const size = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(size.content).toBeLessThanOrEqual(size.viewport);
      if (captureDir) {
        await mkdir(captureDir, { recursive: true });
        await page.screenshot({
          path: join(captureDir, `${state}-top-${testInfo.project.name}.png`),
        });
        if (state !== "malformed") {
          await page.getByRole("heading", { level: 3 }).evaluate((heading) => {
            window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - 96 });
          });
          await page.screenshot({
            path: join(captureDir, `${state}-card-${testInfo.project.name}.png`),
          });
        }
      }
    });
  }
});
