import { mkdir } from "node:fs/promises";
import { buildDecisionsReadModel } from "../../workers-bus/src/decision-read-model.ts";
import { actor, fixture, NOW } from "../../workers-bus/test/decision-read-model-fixture.ts";

import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { nowResponseSchema, type DecisionItem, type NowResponse } from "../src/now/now-contracts";

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
    native_state: "reconciliation_required",
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
        ...(
          ["lead_triage", "quote_revision", "proposal_publication", "production_schedule"] as const
        ).map((kind) => ({
          kind,
          state: "retired" as const,
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        })),
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
      id: pageMarketingId(index),
      key: `postiz:${pageMarketingId(index)}`,
      title: `Synthetic marketing review ${index + 1}`,
      review_href: `/marketing/postiz/${encodeURIComponent(pageMarketingId(index))}`,
    })),
    sources: [
      {
        kind: "postiz",
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

function pageMarketingId(index: number) {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function secondMarketingPage(): NowResponse {
  const model = inboxModel();
  model.decisions = {
    version: 1,
    state: "ready",
    items: [24, 25, 26].map((index) => ({
      ...items[0],
      id: pageMarketingId(index),
      key: `postiz:${pageMarketingId(index)}`,
      title: `Synthetic marketing review ${index + 1}`,
      review_href: `/marketing/postiz/${encodeURIComponent(pageMarketingId(index))}`,
    })),
    sources: [
      {
        kind: "postiz",
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

  test("shows only live kinds with native links and all broker sources explicitly retired", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serveNow(page);
    await expect(page.getByRole("button", { name: "All requests 2", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open review", exact: true })).toHaveCount(2);
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
    for (const label of ["Lead reviews", "Quote changes", "Proposals", "Schedule approvals"]) {
      const retired = page
        .getByRole("list", { name: "Work list status" })
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(retired).toContainText("Retired");
      if (label === "Schedule approvals") {
        await expect(retired).toContainText("Scheduling is handled in the production workspace.");
      } else {
        await expect(retired).toContainText("Stored requests are not current tasks.");
        await expect(retired).not.toContainText("production workspace");
      }
      await expect(retired.getByRole("link")).toHaveCount(0);
    }
    await expect(
      page.getByRole("button", { name: /^(Approve|Reject|Publish|Send|Execute)$/ }),
    ).toHaveCount(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `${shotDir}/decisions-desktop-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("renders the actual persisted-row Worker projection without retired review invitations", async ({
    page,
  }, testInfo) => {
    const f = fixture();
    try {
      for (const index of [0, 1, 2]) {
        f.seed(index, "1", "pending");
        f.seed(index, "2", "execution_uncertain");
        f.seed(index, "3", "pending", "another-tenant");
      }
      const id = f.seed(3, "1", "pending_review");
      f.seed(3, "2", "pending_review", "another-tenant");
      const before = f.db.prepare("SELECT total_changes() AS count").get()!.count;
      const model = inboxModel();
      model.decisions = await buildDecisionsReadModel(f.env, actor("owner"), NOW);
      expect(model.decisions.items.map((item) => item.id)).toEqual([id]);
      if (testInfo.project.name === "mobile-chromium")
        await page.setViewportSize({ width: 320, height: 844 });
      await serveNow(page, model);
      await expect(page.locator(".now-row")).toHaveCount(1);
      const review = page.getByRole("link", { name: "Open review", exact: true });
      await expect(review).toHaveAttribute("href", `/marketing/postiz/${id}`);
      await expect(
        page
          .locator(".now-row")
          .locator(
            'a[href^="/approvals"], a[href^="/quote-revision-approvals"], a[href^="/estimator/jobs/"]',
          ),
      ).toHaveCount(0);
      await page.screenshot({
        path: `${shotDir}/persisted-retirement-${testInfo.project.name}.png`,
        fullPage: true,
      });
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Now", exact: true })
        .click();
      await expect(page.getByRole("heading", { name: "Legacy proposal reviews" })).toBeVisible();
      await expect(page.getByText(/Stored requests are not current review tasks/)).toBeVisible();
      await expect(page.getByRole("list", { name: "Loaded proposal verdicts" })).toHaveCount(0);
      await page.screenshot({
        path: `${shotDir}/now-retired-summary-${testInfo.project.name}.png`,
        fullPage: true,
      });
      await page.goto("/now?show=decide");
      await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
      await page.route("**/api/v1/postiz/**", (route) =>
        route.fulfill({ status: 503, json: { error: "synthetic_read_unavailable" } }),
      );
      await review.click();
      await expect(page).toHaveURL(new RegExp(`/marketing/postiz/${id}$`));
      expect(f.db.prepare("SELECT total_changes() AS count").get()!.count).toBe(before);
    } finally {
      f.db.close();
    }
  });

  test("refuses a stale broker invitation instead of rendering a dead review link", async ({
    page,
  }) => {
    const model = inboxModel();
    const id = "approval:synthetic-lead-0001";
    const stale = {
      ...model,
      decisions: {
        version: 1,
        state: "ready",
        sources: [
          {
            kind: "lead_triage",
            state: "current",
            loaded_count: 1,
            has_more: false,
            next_cursor: null,
            read_model_generated_at: generatedAt,
          },
        ],
        items: [
          {
            ...shared,
            id,
            key: `lead_triage:${id}`,
            kind: "lead_triage",
            native_state: "pending",
            title: "Retired lead invitation",
            job_id: null,
            review_href: `/approvals?review=${encodeURIComponent(id)}`,
          },
        ],
      },
    };
    await page.route(nowRoute, (route) => route.fulfill({ json: stale }));
    await page.goto("/now?show=decide");
    await expect(page.getByRole("link", { name: "Open review" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retired lead invitation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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
    await expect(page.getByRole("button", { name: items[0].title })).toBeVisible();
    await page.getByRole("button", { name: "All requests 2", exact: true }).click();
    await expect(page.locator(".now-row")).toHaveCount(2);
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
          kind: "postiz",
          state: "unavailable",
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        },
        {
          kind: "quickbooks_final_invoice",
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
    await expect(status.getByRole("listitem").filter({ hasText: "Marketing" })).toContainText(
      "The request count is unknown.",
    );
    await expect(status.getByRole("listitem").filter({ hasText: "Final invoices" })).toContainText(
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
          kind: "postiz",
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
    await expect(page.getByRole("button", { name: "Marketing 0", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Final invoices/ })).toHaveCount(0);
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
    await page.getByRole("button", { name: "Marketing 25", exact: true }).click();
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
      id: pageMarketingId(index),
      key: `postiz:${pageMarketingId(index)}`,
      title: `Synthetic marketing review ${index + 1}`,
      review_href: `/marketing/postiz/${encodeURIComponent(pageMarketingId(index))}`,
    }));
    second.decisions = {
      version: 1,
      state: "ready",
      items: [model.decisions!.items[24], ...additional],
      sources: [
        {
          kind: "postiz",
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
      expect(url.searchParams.get("decision_source")).toBe("postiz");
      expect(url.searchParams.get("decision_cursor")).toBe(nextCursor);
      return pageReads.length === 1
        ? route.fulfill({ status: 503, json: { error: "synthetic_next_page_unavailable" } })
        : route.fulfill({ json: second });
    });
    const more = page.getByRole("button", { name: "Load more marketing", exact: true });
    await more.click();
    await expect(page.getByRole("alert")).toContainText("The next requests did not load");
    await expect(page.locator(".now-row")).toHaveCount(25);
    await expect(page.getByRole("button", { name: "All requests 25", exact: true })).toBeVisible();
    await more.click();
    await expect(page.locator(".now-row")).toHaveCount(27);
    expect(pageReads).toHaveLength(2);
    await expect(page.getByRole("button", { name: "All requests 27", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Synthetic marketing review 25", exact: true }),
    ).toHaveCount(1);
    await expect(more).toHaveCount(0);
    await page.getByRole("button", { name: "Synthetic marketing review 26", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "Selected item" });
    await expect(inspector.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      `/marketing/postiz/${encodeURIComponent(pageMarketingId(25))}`,
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
    await expect(page.locator(".now-row")).toHaveCount(2);
    await expect(page.getByRole("button", { name: items[1].title })).toBeVisible();
  });

  test("keeps keyboard focus on Refresh after a successful fresh read", async ({ page }) => {
    await serveNow(page);
    const fresh = inboxModel();
    fresh.decisions!.items[0].title = "Synthetic marketing refreshed successfully";
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
          ? secondMarketingPage()
          : initial,
      }),
    );
    await page.getByRole("button", { name: "Load more marketing", exact: true }).click();
    await page.getByRole("button", { name: "Synthetic marketing review 26", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic marketing review 26" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Open review" }).focus();
    await backgroundRefresh(page);
    await expect(drawer).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Synthetic marketing review 26", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All requests 25", exact: true })).toBeFocused();
  });

  test("ignores an old in-flight page that arrives after the main Refresh", async ({ page }) => {
    const initial = limitedModel();
    await serveNow(page, initial);
    const fresh = limitedModel();
    fresh.decisions!.items[0].title = "Synthetic current snapshot marketing";
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
        return route.fulfill({ json: secondMarketingPage() });
      }
      return route.fulfill({ json: fresh });
    });
    try {
      await page.getByRole("button", { name: "Load more marketing", exact: true }).click();
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
        page.getByRole("button", { name: "Synthetic marketing review 26", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "All requests 25", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Load more marketing", exact: true }),
      ).toHaveCount(0);
    } finally {
      releasePage();
    }
  });

  test("redirects every legacy approvals address to Decisions without a broker read", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The broker-backed lead-review inbox is retired with its Worker routes; no screen may still
    // ask `/api/v1/approvals` for anything.
    const reads: string[] = [];
    await page.route("**/api/v1/approvals**", (route) => {
      reads.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 404, json: { error: "not_found" } });
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
    for (const legacy of [
      "/approvals?review=approval%3Asynthetic-lead-0001",
      "/approvals?view=leads",
    ]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(/\/now\?show=decide$/);
      await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Lead review history" })).toHaveCount(0);
    expect(reads).toEqual([]);
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
    long.title = `Synthetic invoice ${"LongReference".repeat(12)}`;
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
