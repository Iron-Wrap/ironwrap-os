import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import type { AuthenticatedSession } from "../src/auth/session";
import type {
  NewoOperationsOpenCallback,
  NewoOperationsResponse,
} from "../src/newo/newo-operations-contracts";
import { newoOperationsFixture } from "../src/newo/newo-operations-test-fixture";

// Synthetic browser proof only. The real overview parser and /newo role guard run, but browser
// interception supplies the owner session and GET response. This does not exercise Worker cookie
// authentication, D1, provider state, person-write grants, or a callback resolution route.
const syntheticOwner: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "synthetic-newo-owner",
    email: "newo-owner@example.invalid",
    display_name: "Synthetic owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["owner:read"],
  allowed_actions: [],
  csrf_token: "synthetic-newo-read-only",
  session_expires_at: "2030-07-19T18:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-18T18:00:00.000Z",
  stale_fields: [],
};

function callback(
  index: number,
  overrides: Partial<NewoOperationsOpenCallback> = {},
): NewoOperationsOpenCallback {
  return {
    callback_id: `ncb_${index.toString(16).padStart(32, "0")}`,
    session_id: `synthetic-callback-session-${index}`,
    reason: "callback_requested",
    urgency: "routine",
    requested_at: `2026-07-18T18:${index.toString().padStart(2, "0")}:00.000Z`,
    ...overrides,
  };
}

function overview(count: number, callbacks: NewoOperationsOpenCallback[]): NewoOperationsResponse {
  const model = newoOperationsFixture();
  return {
    ...model,
    counts: {
      ...model.counts,
      sessions: count,
      pending_sync: 0,
      failed_sync: 0,
      failed_events: 0,
      missing_reports: 0,
      failed_handoffs: 0,
      open_callbacks: count,
      pending_bookings: 0,
      control_failures: 0,
      dlq_items: 0,
      unresolved_incidents: 0,
    },
    exceptions: {
      missing_reports: [],
      failed_handoffs: [],
      open_callbacks: callbacks,
      pending_bookings: [],
      sync_failures: [],
      failed_events: [],
      dlq_items: [],
      control_failures: [],
    },
    recent_sessions: [],
  };
}

async function openOverview(page: Page, model: NewoOperationsResponse) {
  let failRefresh = false;
  const overviewRequests: string[] = [];
  await page.route("**/api/v1/session", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: syntheticOwner });
  });
  await page.route("**/api/v1/newo/operations", async (route) => {
    overviewRequests.push(route.request().method());
    expect(route.request().method()).toBe("GET");
    if (failRefresh) {
      await route.fulfill({ status: 502, json: { error: "newo_operations_unavailable" } });
    } else {
      await route.fulfill({ json: model });
    }
  });
  await page.goto("/newo");
  await expect(page.getByRole("heading", { name: "Reception", exact: true })).toBeVisible();
  return {
    overviewRequests,
    failNextRefresh: () => {
      failRefresh = true;
    },
  };
}

async function assertReadable(page: Page) {
  const bounds = await page.evaluate(() => ({
    width: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(bounds.contentWidth).toBeLessThanOrEqual(bounds.width + 1);
  const queue = page.getByRole("region", { name: "Calls to return" });
  const textBounds = await queue.locator("li p, li span").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        left: box.left,
        right: box.right,
        fontSize: Number.parseFloat(style.fontSize),
        clipped: element.scrollWidth > element.clientWidth + 1,
      };
    }),
  );
  for (const bounds of textBounds) {
    expect(bounds.left, bounds.text ?? "callback text").toBeGreaterThanOrEqual(0);
    expect(bounds.right, bounds.text ?? "callback text").toBeLessThanOrEqual(
      (page.viewportSize()?.width ?? 0) + 1,
    );
    expect(bounds.fontSize).toBeGreaterThanOrEqual(12);
    expect(bounds.clipped, bounds.text ?? "callback text").toBe(false);
  }
}

async function capture(page: Page, info: TestInfo, model: NewoOperationsResponse) {
  const directory = process.env.NEWO_CAPTURE_DIR;
  if (!directory) return;
  const head = process.env.NEWO_SOURCE_HEAD;
  if (!head || !/^[0-9a-f]{40}$/.test(head)) throw new Error("Exact source head is required");
  await mkdir(directory, { recursive: true });
  const prefix = info.project.name;
  const positions: Record<string, unknown>[] = [];
  for (const [number, position] of ["top", "fully_scrolled"].entries()) {
    const scroll = await page.evaluate((position) => {
      const elements = [document.scrollingElement, ...document.querySelectorAll("*")].filter(
        (element): element is Element => element !== null,
      );
      const scrollable = elements.filter(
        (element) => element.scrollHeight > element.clientHeight + 1,
      );
      for (const element of scrollable) {
        element.scrollTop = position === "top" ? 0 : element.scrollHeight;
      }
      return scrollable.map((element) => ({
        tag: element.tagName,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    }, position);
    const filename = `${prefix}-${number + 1}-${position}.png`;
    await page.screenshot({ path: join(directory, filename), animations: "disabled" });
    positions.push({ filename, position, viewport: page.viewportSize(), scroll });
  }
  // This extra tall image shows the queue between the ordinary top and bottom viewports.
  const filename = `${prefix}-3-callback-queue-supplement.png`;
  await page.getByRole("region", { name: "Calls to return" }).screenshot({
    path: join(directory, filename),
    animations: "disabled",
  });
  positions.push({
    filename,
    position: "callback queue supplement",
    viewport: page.viewportSize(),
  });
  await writeFile(
    join(directory, `${prefix}-fixture.json`),
    JSON.stringify(
      {
        synthetic: true,
        session: { method: "GET", path: "/api/v1/session", response: syntheticOwner },
        overview: { method: "GET", path: "/api/v1/newo/operations", response: model },
        mechanism: "Browser route.fulfill; real browser parser and app role guard; no Worker read",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(directory, `${prefix}-capture.json`),
    JSON.stringify(
      {
        source_head: head,
        dist_manifest_sha256: process.env.NEWO_DIST_MANIFEST_SHA256,
        fixture:
          "Synthetic owner session; callback-only overview; browser-intercepted GET responses",
        grant: "Owner role through existing app RoleGuard; owner:read; allowed_actions=[]",
        backend_authentication_exercised: false,
        provider_runtime_exercised: false,
        url: page.url(),
        positions,
      },
      null,
      2,
    ) + "\n",
  );
}

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(
    info.project.name === "mobile-chromium"
      ? { width: 393, height: 851 }
      : { width: 1440, height: 900 },
  );
});

test("callback-only work stays readable in supplied urgency order without identity or actions", async ({
  page,
}, info) => {
  const callbacks = [
    callback(13, { urgency: "emergency" }),
    callback(12, { urgency: "urgent", reason: "session_failed" }),
    callback(11),
  ];
  const model = overview(3, callbacks);
  const reads = await openOverview(page, model);
  const queue = page.getByRole("region", { name: "Calls to return" });
  await expect(queue).toBeVisible();
  await expect(queue.getByText("Total reported: 3")).toBeVisible();
  await expect(queue.getByRole("listitem")).toHaveCount(3);
  for (const [index, urgency] of ["Emergency", "Urgent", "Routine"].entries()) {
    await expect(queue.getByRole("listitem").nth(index)).toContainText(urgency);
  }
  await expect(queue.getByRole("listitem").nth(0)).toContainText("Call back requested");
  await expect(queue.getByRole("listitem").nth(1)).toContainText("Call failed");
  await expect(queue.getByRole("link")).toHaveCount(0);
  await expect(queue.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("No call or booking needs a check.")).toHaveCount(0);
  for (const row of callbacks) {
    await expect(page.getByText(row.callback_id, { exact: true })).toHaveCount(0);
    await expect(page.getByText(row.session_id, { exact: true })).toHaveCount(0);
  }
  expect(reads.overviewRequests).toEqual(["GET"]);
  await assertReadable(page);
  await capture(page, info, model);
});

test("total count remains distinct from the full bounded returned subset", async ({ page }) => {
  await openOverview(
    page,
    overview(
      31,
      Array.from({ length: 25 }, (_, index) => callback(index + 1)),
    ),
  );
  const queue = page.getByRole("region", { name: "Calls to return" });
  await expect(queue.getByText("Total reported: 31")).toBeVisible();
  await expect(queue.getByText(/25 shown here/)).toBeVisible();
  await expect(queue.getByRole("listitem")).toHaveCount(25);
  await assertReadable(page);
});

test("a positive total with no returned rows keeps work and Refresh visible", async ({ page }) => {
  await openOverview(page, overview(4, []));
  const queue = page.getByRole("region", { name: "Calls to return" });
  await expect(queue.getByText("Total reported: 4")).toBeVisible();
  await expect(queue.getByText("Call details are not in this list. Try Refresh.")).toBeVisible();
  await expect(page.getByText("No call or booking needs a check.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh Reception" })).toBeVisible();
});

test("returned rows survive a separate zero total", async ({ page }) => {
  await openOverview(page, overview(0, [callback(1)]));
  const queue = page.getByRole("region", { name: "Calls to return" });
  await expect(queue.getByText("Total reported: 0")).toBeVisible();
  await expect(queue.getByText("Call back requested")).toBeVisible();
  await expect(queue.getByText("The total and list differ. Try Refresh.")).toBeVisible();
  await expect(page.getByText("No call or booking needs a check.")).toHaveCount(0);
});

test("empty total and empty list keep the existing all-clear", async ({ page }) => {
  await openOverview(page, overview(0, []));
  await expect(page.getByText("No call or booking needs a check.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Calls to return" })).toHaveCount(0);
});

test("failed Refresh retains the saved callback list", async ({ page }) => {
  const reads = await openOverview(page, overview(1, [callback(1)]));
  const queue = page.getByRole("region", { name: "Calls to return" });
  await expect(queue.getByText("Call back requested")).toBeVisible();
  reads.failNextRefresh();
  await page.getByRole("button", { name: "Refresh Reception" }).click();
  await expect(page.getByText("The new list did not load")).toBeVisible();
  await expect(
    page.getByText("The last saved list is still shown. Try Refresh again."),
  ).toBeVisible();
  await expect(queue.getByText("Call back requested")).toBeVisible();
  await expect(page.getByText("No call or booking needs a check.")).toHaveCount(0);
  expect(reads.overviewRequests.every((method) => method === "GET")).toBe(true);
});
