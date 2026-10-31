import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type {
  QuoteRevisionApprovalDetailResponse,
  QuoteRevisionApprovalRequest,
} from "../src/estimator/quote-revision-approval-contracts";
import { expectTouchTarget } from "./touch-target";

const quoteReviewMode = process.env.ACCEPTANCE_MODE === "estimator";
const approvalId = "quote-revision-approval:e2e-001";
const shotDir = ".playwright-mobile";
// Synthetic current native-job identity; it never enters an approval or mutation payload.
const syntheticJob = {
  id: "JOB-ESTIMATOR-ACCEPTANCE",
  roof_job_id: "JOB-ESTIMATOR-ACCEPTANCE",
  job_number: "IW-SYNTHETIC-101",
  customer_display_name: "Synthetic Cedar Household",
  address: "Unit 4, 118 Example Way NW, Edmonton, AB",
};

const approval: QuoteRevisionApprovalRequest = {
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
  requested_by: { user_id: "appu_owner", frappe_user: "owner@example.invalid" },
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

async function serveApproval(
  page: Page,
  initial = structuredClone(approval),
  options: {
    readOnly?: boolean;
    uncertain?: boolean;
    responseGate?: Promise<void>;
    job?: QuoteRevisionApprovalDetailResponse["job"];
  } = {},
) {
  let current = initial;
  const writes: { action: string; body: unknown; idempotencyKey: string | undefined }[] = [];
  await page.route("**/api/v1/quote-revision-approvals/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(new URL(request.url()).search).toBe("");
      expect(request.headers()["x-csrf-token"]).toBe("estimator-acceptance-csrf");
      const action = new URL(request.url()).pathname.split("/").at(-1)!;
      const body = request.postDataJSON();
      writes.push({ action, body, idempotencyKey: request.headers()["idempotency-key"] });
      await options.responseGate;
      current = { ...current, version: current.version + 1 };
      if (action === "approve") {
        current = options.uncertain
          ? { ...current, state: "execution_uncertain", error_code: "broker_response_unverified" }
          : {
              ...current,
              state: "executed",
              hermes_run_id: current.run_id,
              outcome: {
                run_id: current.run_id,
                created: true,
                customer_quote_id: current.target.customer_quote_id,
                quote_version: current.target.quote_version,
                supersedes: current.source.customer_quote_id,
                audit_finalized: true,
                customer_notified: false,
                commercial_terms_copied: false,
                proposal_sent: false,
                accounting_mutated: false,
              },
            };
        if (options.uncertain) {
          await route.fulfill({
            status: 502,
            json: { code: "execution_uncertain", message: "The result could not be verified." },
          });
          return;
        }
      } else if (action === "reject") {
        current = { ...current, state: "denied", rejection_reason: body.reason };
      } else if (action === "reconcile") {
        current = {
          ...current,
          reconciliation: {
            at: "2026-07-18T15:02:00.000Z",
            by_user_id: "appu_owner",
            by_frappe_user: "owner@example.invalid",
            outcome: body.outcome,
            evidence: body.evidence,
          },
        };
      } else {
        throw new Error(`Unexpected decision action: ${action}`);
      }
      await route.fulfill({ json: { approval: current } });
      return;
    }
    expect(new URL(request.url()).searchParams.getAll("include_job_identity")).toEqual(["1"]);
    await route.fulfill({
      json: {
        version: 1,
        read_model_generated_at: "2026-07-18T15:00:00.000Z",
        permissions: ["estimator:read"],
        allowed_actions: [
          "quote_revision_approval.read",
          ...(options.readOnly
            ? []
            : current.state === "pending"
              ? ["quote_revision_approval.approve", "quote_revision_approval.reject"]
              : current.state === "execution_uncertain" && !current.reconciliation
                ? ["quote_revision_approval.reconcile"]
                : []),
        ],
        approval: current,
        ...(Object.hasOwn(options, "job") ? { job: options.job } : {}),
      },
    });
  });
  await page.goto(`/quote-revision-approvals/${encodeURIComponent(initial.id)}`);
  await expect(page.getByRole("heading", { level: 1, name: /Review/ })).toBeVisible();
  return writes;
}

async function expectNoOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
}

test.describe("Quote change review acceptance", () => {
  test.skip(!quoteReviewMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("reads detail identity from its own envelope and retains it across a bound decision", async ({
    page,
  }) => {
    const writes = await serveApproval(page, structuredClone(approval), { job: syntheticJob });
    await expect(page.getByLabel("Job identity")).toHaveText(
      "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
    );
    await page.getByRole("button", { name: "Make empty draft" }).click();
    await expect(page.getByRole("heading", { name: "Draft is ready" })).toBeVisible();
    await expect(page.getByLabel("Job identity")).toHaveText(
      "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ version: 1 });
    await expectNoOverflow(page);
  });

  test("shows missing identity for an older detail instead of an internal job code", async ({
    page,
  }) => {
    await serveApproval(page);
    await expect(page.getByLabel("Job identity")).toHaveText("Job details unavailable");
    await expect(page.getByLabel("Job identity")).not.toContainText(approval.roof_job_id);
  });

  test("rejects a detail identity for another job before showing decision controls", async ({
    page,
  }) => {
    await page.route("**/api/v1/quote-revision-approvals/**", (route) =>
      route.fulfill({
        json: {
          version: 1,
          read_model_generated_at: "synthetic-read",
          permissions: ["estimator:read"],
          allowed_actions: ["quote_revision_approval.read", "quote_revision_approval.approve"],
          approval,
          job: { ...syntheticJob, roof_job_id: "JOB-SYNTHETIC-OTHER" },
        },
      }),
    );
    await page.goto(`/quote-revision-approvals/${encodeURIComponent(approval.id)}`);
    await expect(page.getByRole("heading", { name: "Quote review could not load" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Make empty draft" })).toHaveCount(0);
    await expect(page.getByText(syntheticJob.customer_display_name)).toHaveCount(0);
  });

  test("names the selected estimator job on the preparation route when that action is granted", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === `/api/v1/estimator/jobs/${syntheticJob.id}`,
      async (route) => {
        expect(new URL(route.request().url()).searchParams.getAll("include_job_identity")).toEqual([
          "1",
        ]);
        const response = await route.fetch();
        const model = await response.json();
        await route.fulfill({
          response,
          json: {
            ...model,
            allowed_actions: [...model.allowed_actions, "quote_revision_approval.prepare"],
            job: { ...model.job, ...syntheticJob },
          },
        });
      },
    );
    await page.goto(`/estimator/jobs/${syntheticJob.id}/revision`);
    await expect(page.getByRole("heading", { name: "Ask for a new quote" })).toBeVisible();
    await expect(page.getByLabel("Job identity")).toHaveText(
      "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
    );
    await expectNoOverflow(page);
  });

  test("keeps the choice clear and system IDs out of the first view", async ({
    page,
  }, testInfo) => {
    await serveApproval(page);
    await expect(page.getByRole("heading", { name: "Make the empty draft?" })).toBeVisible();
    await expect(page.getByText("QUOTE-E2E-V4")).toBeHidden();

    await page.screenshot({
      path: `${shotDir}/quote-change-review-${testInfo.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    if (testInfo.project.name === "mobile-chromium") {
      await page.screenshot({
        path: `${shotDir}/quote-phone-first-view.png`,
        animations: "disabled",
      });
      await page.getByRole("complementary", { name: "Decision" }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${shotDir}/quote-phone-decision.png`,
        animations: "disabled",
      });
    }

    const details = page.getByText("System details");
    await details.click();
    await expect(page.getByText("QUOTE-E2E-V4")).toBeVisible();

    for (const [role, name] of [
      ["button", "Load again"],
      ["link", "Open quote"],
      ["button", "Make empty draft"],
      ["button", "Turn down"],
    ] as const) {
      await expectTouchTarget(page.getByRole(role, { name }), { name, axis: "height" });
    }

    await expectNoOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("creates exactly one empty draft and shows the saved result", async ({ page }) => {
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes = await serveApproval(page, structuredClone(approval), { responseGate });
    const create = page.getByRole("button", { name: "Make empty draft" });
    if (page.viewportSize()!.width >= 1024) await expect(create).toBeInViewport();
    await create.focus();
    await page.keyboard.press("Enter");
    try {
      await expect(create).toBeDisabled();
      await expect(page.getByRole("button", { name: "Turn down", exact: true })).toBeDisabled();
    } finally {
      release();
    }
    await expect(page.getByRole("heading", { name: "Draft is ready" })).toBeVisible();
    await expect(create).toBeHidden();
    await expect(page.getByRole("button", { name: "Turn down", exact: true })).toBeHidden();
    expect(writes).toEqual([
      {
        action: "approve",
        body: { version: 1 },
        idempotencyKey: expect.stringMatching(/^quote-revision-approval:decision:/),
      },
    ]);
    await expectNoOverflow(page);
  });

  test("requires a reason to turn down the request and preserves cancel", async ({ page }) => {
    const writes = await serveApproval(page);
    await page.getByRole("button", { name: "Turn down", exact: true }).click();
    await expect(page.getByRole("button", { name: "Turn down request" })).toBeDisabled();
    await page.getByLabel("Why should we stop this request?").fill("Check measurements first.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toHaveLength(0);
    await page.getByRole("button", { name: "Turn down", exact: true }).click();
    await expect(page.getByLabel("Why should we stop this request?")).toHaveValue("");
    await page.getByLabel("Why should we stop this request?").fill("Check measurements first.");
    await page.getByRole("button", { name: "Turn down request" }).click();
    await expect(page.getByRole("heading", { name: "Turned down", exact: true })).toBeVisible();
    expect(writes).toEqual([
      {
        action: "reject",
        body: { version: 1, reason: "Check measurements first." },
        idempotencyKey: expect.stringMatching(/^quote-revision-approval:decision:/),
      },
    ]);
    await expectNoOverflow(page);
  });

  test("keeps an unknown result unknown after an inconclusive check without retrying", async ({
    page,
  }, testInfo) => {
    const writes = await serveApproval(page, structuredClone(approval), { uncertain: true });
    await page.getByRole("button", { name: "Make empty draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Do not try this request again" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Make empty draft" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Your choice was not saved" })).toBeHidden();
    await page.getByRole("button", { name: "Check saved result" }).click();
    await expect(page.getByRole("button", { name: "Save result check" })).toBeDisabled();
    await page
      .getByLabel("What did you check?")
      .fill("The saved record is unavailable; no second request issued.");
    await expectNoOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `${shotDir}/quote-result-check-${testInfo.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Save result check" }).click();
    await expect(page.getByText("Result check saved: Not sure")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Do not try this request again" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Check saved result" })).toBeHidden();
    expect(writes.map(({ action }) => action)).toEqual(["approve", "reconcile"]);
    expect(writes[1].body).toEqual({
      version: 2,
      outcome: "inconclusive",
      evidence: "The saved record is unavailable; no second request issued.",
    });
  });

  test("respects server read-only authority even for an owner session", async ({ page }) => {
    const writes = await serveApproval(page, structuredClone(approval), { readOnly: true });
    await expect(page.getByText("Waiting for the right person")).toBeVisible();
    await expect(page.getByRole("button", { name: "Make empty draft" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Turn down", exact: true })).toBeHidden();
    expect(writes).toHaveLength(0);
  });

  test("fits long request text and identifiers on narrow phones in both themes", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "narrow phone layout");
    const long = structuredClone(approval);
    long.roof_job_id = `JOB-${"LONG-REFERENCE-".repeat(8)}`;
    long.correction_reason = `Confirm the measurement evidence before pricing. ${"MeasurementReference".repeat(20)}`;
    long.preview = null;
    await serveApproval(page, long);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.getByText("System details", { exact: true }).click();
        await expectNoOverflow(page);
        await page.getByText("System details", { exact: true }).click();
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await page.screenshot({
          path: `${shotDir}/quote-long-${width}-${theme}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  });
});
