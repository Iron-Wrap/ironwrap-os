import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The record of a finished job, proven in a browser rather than only in unit tests.
 *
 * Three things are checked against the built app: that a packet slot this system does not carry
 * says so instead of reporting the job as having none, that a customer's finished work is offered
 * as a record rather than a dead end, and that the record opens and shows what was done.
 *
 * The job packet comes from the acceptance server and is modified in flight, so the shape under
 * test stays the real one. The two new reads have no fixture route on that server yet, so they are
 * served here.
 */

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";

const FINISHED_JOB = "JOB-FINISHED-ACCEPTANCE";

const customerHistory = {
  customer: {
    customer_id: "CUSTOMER-ACCEPTANCE",
    display_name: "Northside Holdings",
    lifecycle_status: "active",
  },
  anchor_job_id: "roof-job-acceptance",
  truncated: false,
  generated_at: "2026-09-15T10:00:00.000Z",
  entries: [
    {
      roof_job_id: "roof-job-acceptance",
      job_number: "IW-ACCEPTANCE",
      service_type: "Roofing",
      job_status: "In Production",
      brand: "IronWrap Exteriors",
      property: null,
      is_anchor: true,
      openable: true,
      created_at: "2026-07-01T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    },
    {
      roof_job_id: FINISHED_JOB,
      job_number: "IW-2019",
      service_type: "Metal re-roof",
      job_status: "Complete",
      brand: "IronWrap Exteriors",
      property: {
        property_id: "PROPERTY-OLD",
        address_line1: "88 Riverbend Way",
        city: "Calgary",
        province: "AB",
        postal_code: "T2P 1A1",
        structure_type: "Detached",
      },
      is_anchor: false,
      openable: false,
      created_at: "2024-10-01T10:00:00.000Z",
      updated_at: "2024-11-02T10:00:00.000Z",
    },
  ],
};

const jobHistory = {
  version: 1,
  source_updated_at: "2024-11-02T10:00:00.000Z",
  read_model_generated_at: "2026-09-15T10:00:00.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: [],
  job: {
    id: FINISHED_JOB,
    roof_job_id: FINISHED_JOB,
    job_number: "IW-2019",
    brand: "IronWrap Exteriors",
    service_type: "Metal re-roof",
    status: "Complete",
    address: "88 Riverbend Way, Calgary AB T2P 1A1",
    current_gate_state: "Complete",
  },
  customer: { display_name: "Northside Holdings", phone: "+14035550111" },
  gates: [
    {
      id: "GATE-OLD",
      name: "Materials",
      state: "Done",
      blocker_reason: null,
      owner: "Production dispatch",
      due_at: null,
    },
  ],
  proof: {
    items: [
      {
        id: "evi_finished_north_slope",
        type: "Job plan evidence",
        proof_slot: "North slope",
        occurred_at: "2024-11-02T10:00:00.000Z",
        summary: "Finished roof, north slope",
        customer_safe: false,
        source: "Device camera",
        sync_state: "Verified",
        blocker: false,
      },
    ],
    next_cursor: null,
  },
  openable: false,
  proof_unavailable: false,
};

test.describe("The record of a finished job", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeEach(async ({ page }) => {
    // The real packet, with one slot turned into the state the owned path actually returns.
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE", async (route) => {
      const response = await route.fetch();
      const packet = await response.json();
      packet.stale_fields = ["packet.change_orders.native_unavailable"];
      packet.packet.change_orders = [];
      await route.fulfill({ response, json: packet });
    });
    await page.route("**/api/v1/jobs/*/customer-history", (route) =>
      route.fulfill({ status: 200, json: customerHistory }),
    );
    await page.route(`**/api/v1/jobs/${FINISHED_JOB}/history*`, (route) =>
      route.fulfill({ status: 200, json: jobHistory }),
    );
  });

  test("an uncarried packet slot says so instead of reporting the job as having none", async ({
    page,
  }) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "Job details" })).toBeVisible();

    // The at-a-glance signal is on the closed panel: it no longer reads "0 items", which is what a
    // crew scanning the list actually sees.
    await expect(page.getByText("Not shown here")).toBeVisible();

    // The reason is one tap in, where a crew goes when the count surprises them.
    await page.getByText("Change orders", { exact: true }).click();
    await expect(
      page.getByText("This screen does not carry change orders yet", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(/ask the office before you rely on it/i)).toBeVisible();

    // The measurements slot beside it was looked up and does carry rows, so it still counts them
    // rather than borrowing the same disclaimer.
    await page.getByText("Measurements", { exact: true }).click();
    await expect(page.getByText("RoofRuler")).toBeVisible();
  });

  test("a customer's finished work leads to its record, not to a dead end", async ({ page }) => {
    await page.goto("/jobs/JOB-ACCEPTANCE");

    await expect(page.getByRole("heading", { name: "Earlier work" })).toBeVisible();
    await expect(page.getByText("IW-2019")).toBeVisible();
    await expect(page.getByText("88 Riverbend Way, Calgary, AB, T2P 1A1")).toBeVisible();

    const record = page.getByRole("link", { name: /See what was done/ });
    await expect(record).toBeVisible();
    await record.click();

    await expect(page).toHaveURL(new RegExp(`/jobs/${FINISHED_JOB}/history$`));
    await expect(page.getByRole("heading", { name: "IW-2019" })).toBeVisible();
  });

  test("the record opens, shows what was done, and offers nothing to act on", async ({ page }) => {
    await page.goto(`/jobs/${FINISHED_JOB}/history`);

    await expect(page.getByRole("heading", { name: "IW-2019" })).toBeVisible();
    await expect(page.getByText("Complete · Metal re-roof")).toBeVisible();
    await expect(page.getByText("Nothing on this page changes it")).toBeVisible();
    await expect(page.getByText("Finished roof, north slope")).toBeVisible();

    // The work plan closes with the work, so the page must not offer it.
    await expect(page.getByRole("link", { name: /Open the live job plan/ })).toHaveCount(0);

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test("unreadable proof never renders as no proof", async ({ page }) => {
    await page.route(`**/api/v1/jobs/${FINISHED_JOB}/history*`, (route) =>
      route.fulfill({
        status: 200,
        json: { ...jobHistory, proof_unavailable: true, proof: { items: [], next_cursor: null } },
      }),
    );
    await page.goto(`/jobs/${FINISHED_JOB}/history`);

    await expect(page.getByText("The proof could not be read")).toBeVisible();
    await expect(page.getByText("No sent job proof yet")).toHaveCount(0);
  });
});
