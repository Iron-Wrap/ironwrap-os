import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { salesLeadDetailResponseSchema } from "../src/sales/sales-contracts";
import { expectTouchTarget } from "./touch-target";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";
const leadId = `lead:ironwrap:${"c".repeat(64)}`;
const leadPath = `/sales/leads/${encodeURIComponent(leadId)}/triage`;

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
      id: leadId,
      envelope_id: "bus-external-reference",
      source: "website",
      received_at: "2026-07-12T12:00:00.000Z",
      transport_status: "received",
      intent_queue: "Estimator",
      contact: {
        display_name: "Pat Prospect",
        phone: "+14035559999",
        email: "pat@example.invalid",
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

async function exactLead(page: Page) {
  const data = salesLeadDetailResponseSchema.parse({
    version: 1,
    read_model_generated_at: salesModel.read_model_generated_at,
    permissions: salesModel.permissions,
    allowed_actions: salesModel.allowed_actions,
    stale_fields: [],
    partial_sources: [],
    lead: structuredClone(salesModel.leads[0]),
    intake: {
      name: "Pat Prospect",
      phone: "+14035559999",
      email: "pat@example.invalid",
      address: "123 Synthetic Roof Lane",
      city: "Edmonton",
      province: "AB",
      postal_code: null,
      service: "Roof repair",
      message: "Synthetic caller reported a loose edge. No visit has been promised.",
      source: "office",
      intake_source: "phone",
      preferred_contact_channel: "phone",
      email_consent: {
        status: "not_recorded",
        purpose: "estimate_follow_up",
        recorded_at: null,
        captured_by: null,
        jurisdiction: null,
        wording_version: null,
      },
    },
  });
  const reads = { exact: 0, list: 0 };
  await page.route(
    (url) => decodeURIComponent(url.pathname) === `/api/v1/sales/leads/${leadId}`,
    (route) => {
      reads.exact += 1;
      return route.fulfill({ json: data });
    },
  );
  await page.route("**/api/v1/sales", (route) => {
    reads.list += 1;
    // The requested lead is absent from the bounded list. Its exact read must still work.
    return route.fulfill({
      json: {
        ...salesModel,
        leads: [],
        summary: { ...salesModel.summary, listed_leads: 0, triage_unresolved: 0 },
      },
    });
  });
  return { data, reads };
}

test.describe("Lead check acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("keeps the lead check clear and system IDs out of the first view", async ({
    page,
  }, testInfo) => {
    const { reads } = await exactLead(page);

    await page.goto(leadPath);

    await expect(page.getByRole("heading", { name: "Lead review", exact: true })).toBeVisible();
    await expect(page.getByText("Pat Prospect").first()).toBeVisible();
    await expect(page.getByText(leadId, { exact: true })).toBeHidden();
    await expect(page.getByText("bus-external-reference")).toBeHidden();
    await expect(page.getByText("+14035559999")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save lead review" })).toBeVisible();
    expect(reads.exact).toBeGreaterThan(0);
    expect(reads.list).toBe(0);

    await page.screenshot({
      path: `${shotDir}/lead-check-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details", { exact: true }).click();
    await expect(page.getByText(leadId, { exact: true })).toBeVisible();

    for (const [role, name] of [
      ["link", "Back to Sales"],
      ["button", "Refresh lead"],
      ["button", "Save lead review"],
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

  test("saves the explicit internal review with the exact lead version, without booking or messaging", async ({
    page,
  }) => {
    const { data } = await exactLead(page);
    const commands: Array<{ path: string; body: Record<string, unknown>; key?: string }> = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && request.method() === "POST")
        commands.push({
          path,
          body: request.postDataJSON(),
          key: request.headers()["idempotency-key"],
        });
    });
    await page.route("**/api/v1/commercial/lead-triage-decisions", (route) => {
      const body = route.request().postDataJSON();
      data.lead.triage = { status: "Qualified", summary: body.summary, version: 2 };
      return route.fulfill({
        json: {
          decision: {
            triage_decision_id: "synthetic-decision-p4",
            lead_id: leadId,
            lead_version: 2,
            lifecycle_status: body.lifecycle_status,
            priority: body.priority,
            category: body.category,
            summary: body.summary,
            next_action: body.next_action,
            decided_at: "2026-09-30T12:00:00.000Z",
          },
          replayed: false,
          permit: { permit_id: "synthetic-permit-p4", replayed: false },
        },
      });
    });
    await page.goto(leadPath);
    await expect(page.getByRole("heading", { name: "Lead review", exact: true })).toBeVisible();
    await page.getByLabel("Kind of work", { exact: true }).fill("Roof repair");
    await page
      .getByLabel("Summary for the next person", { exact: true })
      .fill("Synthetic review: roof edge needs an internal assessment.");
    await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
    await page.getByRole("radio", { name: /^Qualified/ }).check();
    await page
      .getByLabel("Next internal action", { exact: true })
      .fill("Check crew availability before proposing a time.");
    await page.getByRole("button", { name: "Save lead review", exact: true }).click();
    await expect(page).toHaveURL(/\/sales$/);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.path).toBe("/api/v1/commercial/lead-triage-decisions");
    expect(commands[0]!.key).toMatch(/^commercial-lead-triage:/);
    expect(commands[0]!.body).toEqual({
      lead_id: leadId,
      expected_lead_version: 1,
      lifecycle_status: "qualified",
      priority: "high",
      category: "Roof repair",
      summary: "Synthetic review: roof edge needs an internal assessment.",
      next_action: "Check crew availability before proposing a time.",
    });
  });
});
