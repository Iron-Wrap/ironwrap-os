import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { nowResponseSchema, type DecisionItem, type NowResponse } from "../src/now/now-contracts";
import type { ApprovalRequest } from "../src/owner/approval-contracts";

// Synthetic API responses qualify the browser presentation only, not live source coverage.
const estimatorMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir =
  process.env.DECISIONS_SCREENSHOT_DIR ?? "../output/p3-decision-inbox-2026-09-29/after";
const generatedAt = "2026-09-29T12:00:00.000Z";
const nowRoute = /\/api\/v1\/now(?:\?.*)?$/;
const nextCursor = "synthetic_cursor_page_two";
const jobId = "JOB-SYNTHETIC-DECISIONS";
const shared = {
  version: 1,
  summary: "Synthetic review request. Check the current work record before choosing an action.",
  job_id: jobId,
  updated_at: generatedAt,
  expires_at: "2030-09-29T12:15:00.000Z",
};

const items: DecisionItem[] = [
  {
    ...shared,
    kind: "lead_triage",
    id: "approval:synthetic-lead-0001",
    key: "lead_triage:approval:synthetic-lead-0001",
    title: "Review synthetic lead note",
    native_state: "pending",
    job_id: null,
    review_href: "/approvals?review=approval%3Asynthetic-lead-0001",
  },
  {
    ...shared,
    kind: "quote_revision",
    id: "quote-revision-approval:synthetic-quote-0001",
    key: "quote_revision:quote-revision-approval:synthetic-quote-0001",
    title: "Check synthetic quote result",
    native_state: "execution_uncertain",
    review_href: "/quote-revision-approvals/quote-revision-approval%3Asynthetic-quote-0001",
  },
  {
    ...shared,
    kind: "proposal_publication",
    id: "proposal-publication-approval:synthetic-proposal-0001",
    key: "proposal_publication:proposal-publication-approval:synthetic-proposal-0001",
    title: "Review synthetic proposal",
    native_state: "pending",
    review_href: `/estimator/jobs/${jobId}`,
  },
  {
    ...shared,
    kind: "postiz",
    id: "2c7bbc97-4062-4d76-8656-2f11cf19eb0e",
    key: "postiz:2c7bbc97-4062-4d76-8656-2f11cf19eb0e",
    title: "Check synthetic marketing result",
    native_state: "reconciliation_required",
    job_id: null,
    expires_at: null,
    review_href: "/marketing/postiz/2c7bbc97-4062-4d76-8656-2f11cf19eb0e",
  },
  {
    ...shared,
    kind: "quickbooks_final_invoice",
    id: "c72eb1ac-7166-4c64-857d-3c64206fa7fb",
    key: "quickbooks_final_invoice:c72eb1ac-7166-4c64-857d-3c64206fa7fb",
    title: "Check synthetic final invoice",
    native_state: "blocked",
    expires_at: null,
    review_href: "/accounting/quickbooks/final-invoices/c72eb1ac-7166-4c64-857d-3c64206fa7fb",
  },
];

function inboxModel(): NowResponse {
  return {
    version: 1,
    role: "owner",
    read_model_generated_at: generatedAt,
    permissions: ["owner.now.read", "approvals:read", "quickbooks:read"],
    allowed_actions: [],
    sources: [],
    decisions: {
      version: 1,
      state: "ready",
      items: structuredClone(items),
      sources: [
        ...items.map((item) => ({
          kind: item.kind,
          state: "current" as const,
          loaded_count: 1,
          has_more: false,
          next_cursor: null,
          read_model_generated_at: generatedAt,
        })),
        {
          kind: "production_schedule",
          state: "retired",
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        },
      ],
    },
    ui: {
      schema_version: 1,
      state: "ready",
      title: "Work to do now",
      explanation: "Synthetic owner work list.",
      sync_label: "Loaded work only.",
      primary_action: null,
      sections: [],
    },
  };
}

function limitedModel(): NowResponse {
  const model = inboxModel();
  model.decisions = {
    version: 1,
    state: "limited",
    items: Array.from({ length: 25 }, (_, index): DecisionItem => ({
      ...items[0],
      id: pageLeadId(index),
      key: `lead_triage:${pageLeadId(index)}`,
      title: `Synthetic lead review ${index + 1}`,
      review_href: `/approvals?review=${encodeURIComponent(pageLeadId(index))}`,
    })),
    sources: [
      {
        kind: "lead_triage",
        state: "limited",
        loaded_count: 25,
        has_more: true,
        next_cursor: nextCursor,
        read_model_generated_at: generatedAt,
      },
    ],
  };
  return model;
}

function pageLeadId(index: number) {
  return `approval:synthetic-page-${String(index).padStart(4, "0")}`;
}

function secondLeadPage(): NowResponse {
  const model = inboxModel();
  model.decisions = {
    version: 1,
    state: "ready",
    items: [24, 25, 26].map((index) => ({
      ...items[0],
      id: pageLeadId(index),
      key: `lead_triage:${pageLeadId(index)}`,
      title: `Synthetic lead review ${index + 1}`,
      review_href: `/approvals?review=${encodeURIComponent(pageLeadId(index))}`,
    })),
    sources: [
      {
        kind: "lead_triage",
        state: "current",
        loaded_count: 3,
        has_more: false,
        next_cursor: null,
        read_model_generated_at: generatedAt,
      },
    ],
  };
  return nowResponseSchema.parse(model);
}

async function backgroundRefresh(page: Page) {
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/now" && !url.searchParams.has("decision_source");
  });
  // Exercise the app's configured refetch-on-return handler without clicking behind a modal.
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await response;
}

const test = base.extend<{ noBusinessWrites: void }>({
  noBusinessWrites: [
    async ({ page }, use) => {
      const writes: string[] = [];
      const nowReads: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/v1/now") nowReads.push(request.url());
        if (
          new URL(request.url()).pathname.startsWith("/api/") &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method())
        ) {
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
      });
      await page.route("**/api/**", (route) =>
        ["GET", "HEAD", "OPTIONS"].includes(route.request().method())
          ? route.fallback()
          : route.fulfill({ status: 409, json: { error: "unexpected_browsing_write" } }),
      );
      await use();
      expect(writes, "Browsing, filtering, selection and refresh must not issue commands").toEqual(
        [],
      );
      for (const url of nowReads) {
        expect(
          new URL(url).searchParams.get("include_decisions"),
          "Now explicitly opts into the new projection",
        ).toBe("1");
      }
    },
    { auto: true },
  ],
});

async function serveNow(page: Page, model = inboxModel(), route = "/now?show=decide") {
  // Validate fixtures before browser use so a typo cannot turn a coverage check into an error view.
  nowResponseSchema.parse(model);
  await page.route(nowRoute, (request) => request.fulfill({ json: model }));
  await page.goto(route);
  await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
}

async function noOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>(".now-page, dialog[open]")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => node.className),
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.overflowing).toEqual([]);
}

async function settleTheme(page: Page) {
  // Theme changes animate control colors; audit the settled theme, not an intermediate frame.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

test.describe("HOME04 decision inbox browser evidence", () => {
  test.skip(!estimatorMode, "requires the estimator acceptance session (owner role)");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows five live kinds with native links and no retired schedule action", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serveNow(page);
    await expect(page.getByRole("button", { name: "All requests 5", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open review", exact: true })).toHaveCount(5);
    for (const item of items) {
      const row = page
        .locator(".now-row")
        .filter({ has: page.getByRole("button", { name: item.title }) });
      await expect(row.getByRole("link", { name: "Open review" })).toHaveAttribute(
        "href",
        item.review_href,
      );
    }
    await expect(page.getByRole("button", { name: /Schedule approvals/ })).toHaveCount(0);
    await page.getByText("System details", { exact: true }).click();
    const retired = page
      .getByRole("list", { name: "Work list status" })
      .getByRole("listitem")
      .filter({ hasText: "Schedule approvals" });
    await expect(retired).toContainText("Retired");
    await expect(retired.getByRole("link")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^(Approve|Reject|Publish|Send|Execute)$/ }),
    ).toHaveCount(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `${shotDir}/decisions-desktop-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("supports keyboard selection, filtering and closing the desktop inspector", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serveNow(page);
    const first = page.getByRole("button", { name: items[0].title, exact: true });
    await first.focus();
    await page.keyboard.press("Enter");
    const inspector = page.getByRole("complementary", { name: "Selected item" });
    await expect(inspector.getByRole("heading", { name: items[0].title })).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.getByRole("button", { name: items[1].title, exact: true })).toBeFocused();
    await expect(inspector).toContainText("Check the result");
    await expect(inspector.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      items[1].review_href,
    );
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(first).toBeFocused();
    await page.getByRole("button", { name: "Marketing 1", exact: true }).click();
    await expect(page.locator(".now-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: items[3].title })).toBeVisible();
    await page.getByRole("button", { name: "All requests 5", exact: true }).click();
    await expect(page.locator(".now-row")).toHaveCount(5);
  });

  test("opens a modal phone drawer and restores focus after Escape", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveNow(page);
    const selected = page.getByRole("button", { name: items[1].title, exact: true });
    await selected.click();
    const drawer = page.getByRole("dialog", { name: items[1].title });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      items[1].review_href,
    );
    await expect(drawer).toContainText("Check the result");
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Tab");
      // Chromium may focus browser chrome after the final modal control (activeElement=body).
      // It must never focus an interactive element in the inert background page.
      expect(
        await drawer.evaluate(
          (element) =>
            element.matches(":modal") &&
            (element.contains(document.activeElement) || document.activeElement === document.body),
        ),
      ).toBe(true);
    }
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .evaluate((button) => button.focus());
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: `${shotDir}/decisions-drawer-${testInfo.project.name}.png` });
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(selected).toBeFocused();
  });

  test("keeps a missing projection visibly unavailable instead of claiming no work", async ({
    page,
  }) => {
    const model = inboxModel();
    delete model.decisions;
    await serveNow(page, model);
    await expect(page.getByText("The decisions list is incomplete", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Refresh to load decision sources.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No open requests in the connected decision sources.", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open review" })).toHaveCount(0);
  });

  test("distinguishes an unavailable source and unknown count from a real empty source", async ({
    page,
  }) => {
    const model = inboxModel();
    model.decisions = {
      version: 1,
      state: "limited",
      items: [],
      sources: [
        {
          kind: "lead_triage",
          state: "unavailable",
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        },
        {
          kind: "quote_revision",
          state: "current",
          loaded_count: 0,
          has_more: false,
          next_cursor: null,
          read_model_generated_at: generatedAt,
        },
      ],
    };
    await serveNow(page, model);
    await expect(
      page.getByText("Requests could not be checked. Refresh to try again."),
    ).toBeVisible();
    await page.getByText("System details", { exact: true }).click();
    const status = page.getByRole("list", { name: "Work list status" });
    await expect(status.getByRole("listitem").filter({ hasText: "Lead reviews" })).toContainText(
      "The request count is unknown.",
    );
    await expect(status.getByRole("listitem").filter({ hasText: "Quote changes" })).toContainText(
      "0 loaded.",
    );
    await expect(
      page.getByText("No open requests in the connected decision sources.", { exact: true }),
    ).toHaveCount(0);
  });

  test("reports no open requests only when the connected source was checked", async ({ page }) => {
    const model = inboxModel();
    model.decisions = {
      version: 1,
      state: "empty",
      items: [],
      sources: [
        {
          kind: "lead_triage",
          state: "current",
          loaded_count: 0,
          has_more: false,
          next_cursor: null,
          read_model_generated_at: generatedAt,
        },
      ],
    };
    await serveNow(page, model);
    await expect(
      page.getByText("No open requests in the connected decision sources.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("The decisions list is incomplete", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "All requests 0", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Marketing|Final invoices/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open review" })).toHaveCount(0);
  });

  test("labels truncated counts as loaded and preserves the more-requests warning after filtering", async ({
    page,
  }) => {
    const model = limitedModel();
    await serveNow(page, model);
    await expect(page.getByRole("button", { name: "All requests 25", exact: true })).toBeVisible();
    await expect(
      page.getByText("25 requests loaded; more are available in this source.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lead reviews 25", exact: true }).click();
    await expect(page.locator(".now-row")).toHaveCount(25);
    await expect(page.getByText("The decisions list is incomplete", { exact: true })).toBeVisible();
    await page.getByText("System details", { exact: true }).click();
    await expect(
      page.getByText("25 loaded; the full source has more requests", { exact: false }),
    ).toBeVisible();
  });

  test("retries a failed second page without losing rows, deduplicates, and resets on refresh", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const model = limitedModel();
    const second = inboxModel();
    const additional: DecisionItem[] = [25, 26].map((index) => ({
      ...items[0],
      id: pageLeadId(index),
      key: `lead_triage:${pageLeadId(index)}`,
      title: `Synthetic lead review ${index + 1}`,
      review_href: `/approvals?review=${encodeURIComponent(pageLeadId(index))}`,
    }));
    second.decisions = {
      version: 1,
      state: "ready",
      items: [model.decisions!.items[24], ...additional],
      sources: [
        {
          kind: "lead_triage",
          state: "current",
          loaded_count: 3,
          has_more: false,
          next_cursor: null,
          read_model_generated_at: generatedAt,
        },
      ],
    };
    nowResponseSchema.parse(second);
    await serveNow(page, model);
    const pageReads: string[] = [];
    await page.route(nowRoute, (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("decision_source")) return route.fulfill({ json: model });
      pageReads.push(url.search);
      expect(url.searchParams.get("decision_source")).toBe("lead_triage");
      expect(url.searchParams.get("decision_cursor")).toBe(nextCursor);
      return pageReads.length === 1
        ? route.fulfill({ status: 503, json: { error: "synthetic_next_page_unavailable" } })
        : route.fulfill({ json: second });
    });
    const more = page.getByRole("button", { name: "Load more lead reviews", exact: true });
    await more.click();
    await expect(page.getByRole("alert")).toContainText("The next requests did not load");
    await expect(page.locator(".now-row")).toHaveCount(25);
    await expect(page.getByRole("button", { name: "All requests 25", exact: true })).toBeVisible();
    await more.click();
    await expect(page.locator(".now-row")).toHaveCount(27);
    expect(pageReads).toHaveLength(2);
    await expect(page.getByRole("button", { name: "All requests 27", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Synthetic lead review 25", exact: true }),
    ).toHaveCount(1);
    await expect(more).toHaveCount(0);
    await page.getByRole("button", { name: "Synthetic lead review 26", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "Selected item" });
    await expect(inspector.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      `/approvals?review=${encodeURIComponent(pageLeadId(25))}`,
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".now-row")).toHaveCount(25);
    await expect(inspector).toHaveCount(0);
    await expect(more).toBeVisible();
  });

  test("keeps loaded work and uncertainty visible when refresh fails", async ({ page }) => {
    await serveNow(page);
    await page.route(nowRoute, (route) =>
      route.fulfill({ status: 503, json: { error: "synthetic_source_unavailable" } }),
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The new list did not load");
    await expect(page.locator(".now-row")).toHaveCount(5);
    await expect(page.getByRole("button", { name: items[1].title })).toBeVisible();
  });

  test("keeps keyboard focus on Refresh after a successful fresh read", async ({ page }) => {
    await serveNow(page);
    const fresh = inboxModel();
    fresh.decisions!.items[0].title = "Synthetic lead refreshed successfully";
    await page.route(nowRoute, (route) => route.fulfill({ json: fresh }));
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: fresh.decisions!.items[0].title })).toBeVisible();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
  });

  test("preserves a selected initial row and phone dialog across a background fresh read", async ({
    page,
  }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await serveNow(page);
      await page.getByRole("button", { name: items[1].title, exact: true }).click();
      const details =
        width === 1440
          ? page.getByRole("complementary", { name: "Selected item" })
          : page.getByRole("dialog", { name: items[1].title });
      await expect(details).toBeVisible();
      const fresh = inboxModel();
      fresh.decisions!.items[1].summary = `Synthetic updated source evidence at width ${width}.`;
      await page.route(nowRoute, (route) => route.fulfill({ json: fresh }));
      await backgroundRefresh(page);
      await expect(details).toBeVisible();
      await expect(
        details.getByText(fresh.decisions!.items[1].summary, { exact: true }),
      ).toBeVisible();
      await expect(details.getByRole("link", { name: "Open review" })).toHaveAttribute(
        "href",
        items[1].review_href,
      );
      if (width === 390)
        expect(await details.evaluate((element) => element.matches(":modal"))).toBe(true);
    }
  });

  test("clears a removed second-page selection and gives phone focus back to the list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const initial = limitedModel();
    await serveNow(page, initial);
    await page.route(nowRoute, (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.has("decision_source")
          ? secondLeadPage()
          : initial,
      }),
    );
    await page.getByRole("button", { name: "Load more lead reviews", exact: true }).click();
    await page.getByRole("button", { name: "Synthetic lead review 26", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic lead review 26" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Open review" }).focus();
    await backgroundRefresh(page);
    await expect(drawer).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Synthetic lead review 26", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All requests 25", exact: true })).toBeFocused();
  });

  test("ignores an old in-flight page that arrives after the main Refresh", async ({ page }) => {
    const initial = limitedModel();
    await serveNow(page, initial);
    const fresh = limitedModel();
    fresh.decisions!.items[0].title = "Synthetic current snapshot lead";
    fresh.decisions!.state = "ready";
    Object.assign(fresh.decisions!.sources[0], {
      state: "current",
      has_more: false,
      next_cursor: null,
    });
    nowResponseSchema.parse(fresh);
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let pageRequested = false;
    await page.route(nowRoute, async (route) => {
      if (new URL(route.request().url()).searchParams.has("decision_source")) {
        pageRequested = true;
        await pageGate;
        return route.fulfill({ json: secondLeadPage() });
      }
      return route.fulfill({ json: fresh });
    });
    try {
      await page.getByRole("button", { name: "Load more lead reviews", exact: true }).click();
      await expect.poll(() => pageRequested).toBe(true);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(
        page.getByRole("button", { name: fresh.decisions!.items[0].title }),
      ).toBeVisible();
      const oldPage = page.waitForResponse((response) =>
        new URL(response.url()).searchParams.has("decision_source"),
      );
      releasePage();
      await (await oldPage).finished();
      await settleTheme(page);
      await expect(page.locator(".now-row")).toHaveCount(25);
      await expect(
        page.getByRole("button", { name: "Synthetic lead review 26", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "All requests 25", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Load more lead reviews", exact: true }),
      ).toHaveCount(0);
    } finally {
      releasePage();
    }
  });

  test("redirects only the default legacy route and preserves exact lead review and history", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const lead: ApprovalRequest = {
      id: items[0].id,
      kind: "lead_triage",
      state: "pending",
      version: 1,
      action: "mark_lead_triaged",
      target: {
        doctype: "Lead Envelope",
        name: "synthetic-lead",
        lead_envelope_id: "synthetic-lead",
      },
      request_text: "Synthetic lead note awaiting a separate review.",
      preview: null,
      expires_at: "2030-09-29T12:15:00.000Z",
      requested_by: { user_id: "synthetic-owner", frappe_user: "owner@example.invalid" },
      approved_by: null,
      rejection_reason: null,
      run_id: "synthetic-lead-run",
      hermes_run_id: null,
      outcome: null,
      error_code: null,
      reconciliation: null,
      created_at: generatedAt,
      updated_at: generatedAt,
      completed_at: null,
    };
    const envelope = {
      version: 1,
      read_model_generated_at: generatedAt,
      permissions: ["approvals:read"],
      allowed_actions: [],
    };
    const reads: string[] = [];
    await page.route("**/api/v1/approvals**", (route) => {
      const path = new URL(route.request().url()).pathname;
      reads.push(path);
      return route.fulfill({
        json:
          path === "/api/v1/approvals"
            ? { ...envelope, approvals: [lead] }
            : { ...envelope, approval: lead },
      });
    });
    await serveNow(page, inboxModel(), "/approvals");
    await expect(page).toHaveURL(/\/now\?show=decide$/);
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation.getByRole("link", { name: "Decisions", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByRole("link", { name: "Now", exact: true })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(reads).toEqual([]);
    await navigation.getByRole("link", { name: "Now", exact: true }).click();
    await expect(page).toHaveURL(/\/now$/);
    await expect(page.getByRole("heading", { level: 1, name: "Work to do now" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Now", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      navigation.getByRole("link", { name: "Decisions", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await navigation.getByRole("link", { name: "Decisions", exact: true }).click();
    await expect(page).toHaveURL(/\/now\?show=decide$/);
    await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
    await page
      .locator(".now-row")
      .filter({ hasText: items[0].title })
      .getByRole("link", { name: "Open review" })
      .click();
    await expect(page).toHaveURL(/\/approvals\?review=approval%3Asynthetic-lead-0001$/);
    await expect(page.getByRole("heading", { level: 1, name: "Review lead note" })).toBeVisible();
    expect(reads).toEqual(["/api/v1/approvals/approval%3Asynthetic-lead-0001"]);
    await page.goto("/approvals?view=leads");
    await expect(page).toHaveURL(/\/approvals\?view=leads$/);
    await expect(page.getByRole("heading", { level: 1, name: "Lead reviews" })).toBeVisible();
    expect(reads).toContain("/api/v1/approvals");
  });

  test("does not show another role's decisions", async ({ page }) => {
    const model = inboxModel();
    model.role = "accounting";
    await page.route(nowRoute, (route) => route.fulfill({ json: model }));
    await page.goto("/now?show=decide");
    await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
    await expect(page.locator(".now-row")).toHaveCount(0);
  });

  test("fits long decision content at 320 and 390 in both themes with accessible list and drawer", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const model = inboxModel();
    const long = model.decisions!.items[1];
    long.title = `Synthetic quote ${"LongReference".repeat(12)}`;
    long.summary = `Check this synthetic evidence before deciding. ${"MeasurementReference".repeat(40)}`;
    long.job_id = `JOB-${"LONG-".repeat(25)}`;
    await serveNow(page, model);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settleTheme(page);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await noOverflow(page);
        const listAxe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(listAxe.violations).toEqual([]);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await page.screenshot({
          path: `${shotDir}/decisions-${width}-${theme}-${testInfo.project.name}.png`,
          fullPage: true,
        });
        await page.getByRole("button", { name: long.title, exact: true }).click();
        const drawer = page.getByRole("dialog", { name: long.title });
        await expect(drawer).toBeVisible();
        await noOverflow(page);
        await drawer.getByRole("link", { name: "Open review" }).scrollIntoViewIfNeeded();
        await expect(drawer.getByRole("link", { name: "Open review" })).toBeInViewport();
        const drawerAxe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(drawerAxe.violations).toEqual([]);
        await page.screenshot({
          path: `${shotDir}/decisions-long-drawer-${width}-${theme}-${testInfo.project.name}.png`,
        });
        await drawer.getByRole("button", { name: "Close", exact: true }).click();
      }
    }
  });
});
