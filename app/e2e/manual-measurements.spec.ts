import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page, type Locator } from "@playwright/test";

import {
  manualMeasurementInputSchema,
  manualMeasurementRequestIdSchema,
  manualMeasurementsResponseSchema,
  type ManualMeasurementInput,
} from "../src/estimator/manual-measurement-contracts";
import { expectTouchTarget } from "./touch-target";

// These synthetic, process-local receipts prove browser behavior, not native D1 persistence.
const shotDir =
  process.env.MANUAL_MEASUREMENTS_SCREENSHOT_DIR ??
  "../output/p4-manual-measurements-2026-09-30/after";
const panel = (page: Page) =>
  page.getByRole("region", { name: "Manual measurements", exact: true });
const facts = {
  area_sq_ft: 1200.5,
  area_basis: "roof_surface" as const,
  pitch_rise_per_12: 6,
  method: "tape" as const,
  uncertainty: "Synthetic observation; north eave requires a second physical check.",
  correction_reason: null,
};
type Command = { key: string; body: ManualMeasurementInput };
type ManualFixture = {
  jobId: string;
  path: string;
  endpoint: string;
  commands: Command[];
  reads: string[];
};

const test = base.extend<{ manual: ManualFixture }>({
  manual: async ({ page }, provide) => {
    const jobId = `JOB-MANUAL-${randomUUID()}`;
    const endpoint = `/api/v1/estimator/jobs/${jobId}/manual-measurements`;
    const commands: Command[] = [];
    const reads: string[] = [];
    const unexpected: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        if (url.pathname === endpoint) reads.push(url.search);
        return;
      }
      if (request.method() !== "POST" || url.pathname !== endpoint) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return;
      }
      expect(request.headers()["x-csrf-token"]).toBe("estimator-acceptance-csrf");
      commands.push({
        key: manualMeasurementRequestIdSchema.parse(request.headers()["idempotency-key"]),
        body: manualMeasurementInputSchema.parse(request.postDataJSON()),
      });
    });
    await page.route("**/api/**", (route) => {
      const request = route.request();
      const allowed =
        ["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
        (request.method() === "POST" && new URL(request.url()).pathname === endpoint);
      return allowed
        ? route.fallback()
        : route.fulfill({ status: 409, json: { error: "unexpected_ui_command" } });
    });
    await provide({ jobId, endpoint, path: `/estimator/jobs/${jobId}`, commands, reads });
    expect(
      unexpected,
      "Manual observations must never mutate geometry, takeoffs, quotes, or another job",
    ).toEqual([]);
  },
});

async function openPanel(page: Page, path: string) {
  await page.goto(path);
  const roof = page.locator("summary").filter({ hasText: "Roof details" });
  await expect(roof).toBeVisible();
  if (!(await roof.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await roof.click();
  await expect(panel(page)).toBeVisible();
}

async function fillObservation(page: Page, label = "Synthetic north roof") {
  const region = panel(page);
  await region.getByLabel("Area label", { exact: true }).fill(label);
  await region.getByLabel("Area (sq ft)", { exact: true }).fill(String(facts.area_sq_ft));
  await region
    .getByRole("combobox", { name: "Area basis", exact: true })
    .selectOption(facts.area_basis);
  await region
    .getByLabel("Pitch (rise per 12)", { exact: true })
    .fill(String(facts.pitch_rise_per_12));
  await region
    .getByRole("combobox", { name: "Measurement method", exact: true })
    .selectOption(facts.method);
  await region
    .getByRole("textbox", { name: "Uncertainty or limitations", exact: true })
    .fill(facts.uncertainty);
}

async function readSaved(page: Page, fixture: ManualFixture) {
  const response = await page.request.get(fixture.endpoint);
  expect(response.ok()).toBe(true);
  return manualMeasurementsResponseSchema.parse(await response.json());
}

async function settleRendering(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Match Playwright's screenshot animation handling: finish finite transitions,
    // rather than awaiting idle/paused animations whose finished promise never settles.
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) {
        try {
          animation.finish();
        } catch {
          /* A canceled animation has no visual work left. */
        }
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function record(page: Page, fixture: ManualFixture) {
  await fillObservation(page);
  await panel(page).getByRole("button", { name: "Save observation", exact: true }).click();
  await expect(
    panel(page).getByRole("region", { name: "Saved observation", exact: true }),
  ).toBeVisible();
  const saved = await readSaved(page, fixture);
  expect(saved.areas).toHaveLength(1);
  return saved;
}

test.describe("Manual roof observations", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "requires ACCEPTANCE_MODE=estimator");
  test.beforeAll(async () => mkdir(shotDir, { recursive: true }).then(() => undefined));

  test("captures on a numberless job and reloads exact source facts without downstream changes", async ({
    page,
    manual,
  }) => {
    const before = await (await page.request.get(`/api/v1/estimator/jobs/${manual.jobId}`)).json();
    expect(before.job.job_number).toBeNull();
    await openPanel(page, manual.path);
    expect(manual.commands).toHaveLength(0);
    const saved = await record(page, manual);
    expect(manual.commands).toHaveLength(1);
    expect(manual.commands[0].body).toEqual({
      expected_job_version: 1,
      expected_observation_head: null,
      target: { new_area_label: "Synthetic north roof" },
      ...facts,
    });
    expect(saved.areas[0]).toMatchObject({
      ...facts,
      area_label: "Synthetic north roof",
      revision: 1,
      job_id: manual.jobId,
    });
    const after = await (await page.request.get(`/api/v1/estimator/jobs/${manual.jobId}`)).json();
    expect(after).toEqual(before);
    await openPanel(page, page.url());
    await expect(
      panel(page)
        .getByText(/Synthetic north roof · Revision 1/)
        .first(),
    ).toBeVisible();
    expect((await readSaved(page, manual)).history.items).toEqual(saved.history.items);
    expect(manual.commands).toHaveLength(1);
  });

  test("requires real facts and appends a correction with reason while retaining its predecessor", async ({
    page,
    manual,
  }) => {
    await openPanel(page, manual.path);
    await panel(page).getByLabel("Area label", { exact: true }).fill("No fabricated zero");
    await expect(
      panel(page).getByRole("button", { name: "Save observation", exact: true }),
    ).toBeDisabled();
    expect(manual.commands).toHaveLength(0);
    const initial = await record(page, manual);
    await panel(page)
      .getByRole("button", { name: "Record another observation", exact: true })
      .click();
    await panel(page)
      .getByRole("button", { name: /^Correct observation:/ })
      .click();
    await panel(page).getByLabel("Area (sq ft)", { exact: true }).fill("1240");
    const save = panel(page).getByRole("button", { name: "Save correction", exact: true });
    await expect(save).toBeDisabled();
    expect(manual.commands).toHaveLength(1);
    await panel(page)
      .getByRole("textbox", { name: "Correction reason", exact: true })
      .fill("Synthetic second tape check includes the north overhang.");
    await save.click();
    await expect.poll(async () => (await readSaved(page, manual)).history.items.length).toBe(2);
    const corrected = await readSaved(page, manual);
    expect(corrected.areas[0]).toMatchObject({
      area_sq_ft: 1240,
      revision: 2,
      supersedes_observation_id: initial.areas[0].id,
    });
    expect(corrected.history.items[1]).toEqual(initial.history.items[0]);
    expect(manual.commands[1].body).toMatchObject({
      expected_observation_head: initial.observation_head,
      expected_job_version: initial.job.version,
      target: { area_id: initial.areas[0].area_id },
    });
    await openPanel(page, page.url());
    await expect(
      panel(page)
        .getByText(/Synthetic second tape check includes the north overhang/)
        .first(),
    ).toBeVisible();
  });

  test("does not silently overwrite a newer observation after a CAS conflict", async ({
    page,
    manual,
  }) => {
    await openPanel(page, manual.path);
    const initial = await record(page, manual);
    await panel(page)
      .getByRole("button", { name: "Record another observation", exact: true })
      .click();
    await panel(page)
      .getByRole("button", { name: /^Correct observation:/ })
      .click();
    await panel(page).getByLabel("Area (sq ft)", { exact: true }).fill("1300");
    await panel(page)
      .getByRole("textbox", { name: "Correction reason", exact: true })
      .fill("Synthetic intended correction remains unsaved.");
    const other = await page.request.post(manual.endpoint, {
      headers: {
        "X-CSRF-Token": "estimator-acceptance-csrf",
        "Idempotency-Key": `manual-measurement:${randomUUID()}`,
      },
      data: {
        ...facts,
        expected_job_version: initial.job.version,
        expected_observation_head: initial.observation_head,
        target: { new_area_label: "Synthetic newer south roof" },
      },
    });
    expect(other.ok()).toBe(true);
    await panel(page).getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(
      panel(page).getByText(/The server refused this save\. Refresh measurements/),
    ).toBeVisible();
    expect(manual.commands).toHaveLength(2);
    const final = await readSaved(page, manual);
    expect(final.history.items).toHaveLength(2);
    expect(final.areas.find((area) => area.area_id === initial.areas[0].area_id)?.area_sq_ft).toBe(
      1200.5,
    );
  });

  test("reconciles a lost acknowledgement by exact receipt without automatically repeating the write", async ({
    page,
    manual,
  }) => {
    let failReceiptRead = true;
    await page.route(`**${manual.endpoint}*`, async (route) => {
      if (route.request().method() !== "POST") {
        if (new URL(route.request().url()).searchParams.has("request_id") && failReceiptRead) {
          failReceiptRead = false;
          return route.fulfill({
            status: 503,
            json: { error: "synthetic_receipt_temporarily_unavailable" },
          });
        }
        return route.fallback();
      }
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      return route.abort("failed");
    });
    await openPanel(page, manual.path);
    await fillObservation(page);
    await panel(page).getByRole("button", { name: "Save observation", exact: true }).click();
    const check = panel(page).getByRole("button", { name: "Check saved observation", exact: true });
    await expect(check).toBeVisible();
    expect(manual.commands).toHaveLength(1);
    await check.click();
    await expect(
      panel(page).getByRole("region", { name: "Saved observation", exact: true }),
    ).toBeVisible();
    expect(
      manual.reads.some(
        (query) => new URLSearchParams(query).get("request_id") === manual.commands[0].key,
      ),
    ).toBe(true);
    expect(manual.commands).toHaveLength(1);
    expect((await readSaved(page, manual)).history.items).toHaveLength(1);
  });

  test("explicit retry after an absent receipt keeps the exact original key and body", async ({
    page,
    manual,
  }) => {
    let attempts = 0;
    await page.route(`**${manual.endpoint}`, (route) => {
      if (route.request().method() === "POST" && ++attempts === 1) return route.abort("failed");
      return route.fallback();
    });
    await openPanel(page, manual.path);
    await fillObservation(page);
    await panel(page).getByRole("button", { name: "Save observation", exact: true }).click();
    await panel(page).getByRole("button", { name: "Check saved observation", exact: true }).click();
    const retry = panel(page).getByRole("button", { name: "Retry same observation", exact: true });
    await expect(retry).toBeVisible();
    expect(manual.commands).toHaveLength(1);
    await retry.click();
    await expect(
      panel(page).getByRole("region", { name: "Saved observation", exact: true }),
    ).toBeVisible();
    expect(manual.commands).toHaveLength(2);
    expect(manual.commands[1]).toEqual(manual.commands[0]);
    expect((await readSaved(page, manual)).history.items).toHaveLength(1);
  });

  test("double click submits one immutable observation", async ({ page, manual }) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${manual.endpoint}`, async (route) => {
      if (route.request().method() === "POST") await pending;
      return route.fallback();
    });
    await openPanel(page, manual.path);
    await fillObservation(page);
    try {
      await panel(page).getByRole("button", { name: "Save observation", exact: true }).dblclick();
      await expect.poll(() => manual.commands.length).toBe(1);
    } finally {
      release();
    }
    await expect(
      panel(page).getByRole("region", { name: "Saved observation", exact: true }),
    ).toBeVisible();
    expect((await readSaved(page, manual)).history.items).toHaveLength(1);
  });

  test("reload reads the exact unresolved receipt and never reconstructs an unsent command", async ({
    page,
    manual,
  }) => {
    await page.route(`**${manual.endpoint}`, (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.fallback(),
    );
    await openPanel(page, manual.path);
    await fillObservation(page);
    await panel(page).getByRole("button", { name: "Save observation", exact: true }).click();
    await expect(
      panel(page).getByRole("button", { name: "Check saved observation", exact: true }),
    ).toBeVisible();
    const key = manual.commands[0].key;
    expect(new URL(page.url()).searchParams.get("measurementRequest")).toBe(key);
    await openPanel(page, page.url());
    await panel(page).getByRole("button", { name: "Check saved observation", exact: true }).click();
    await expect(panel(page).getByText(/reopened without the original entry/)).toBeVisible();
    await expect(
      panel(page).getByRole("button", { name: "Retry same observation", exact: true }),
    ).toHaveCount(0);
    await expect(panel(page).getByLabel("Area label", { exact: true })).toHaveCount(0);
    expect(manual.commands).toHaveLength(1);
    expect((await readSaved(page, manual)).history.items).toHaveLength(0);
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(storage).not.toContain("Synthetic north roof");
    expect(storage).not.toContain(facts.uncertainty);
  });

  test("a recovered earlier receipt stays distinct from the latest corrected area", async ({
    page,
    manual,
  }) => {
    await openPanel(page, manual.path);
    const first = await record(page, manual);
    const receiptUrl = page.url();
    const correction = await page.request.post(manual.endpoint, {
      headers: {
        "X-CSRF-Token": "estimator-acceptance-csrf",
        "Idempotency-Key": `manual-measurement:${randomUUID()}`,
      },
      data: {
        ...facts,
        area_sq_ft: 1250,
        correction_reason: "Synthetic later physical remeasurement.",
        expected_job_version: first.job.version,
        expected_observation_head: first.observation_head,
        target: { area_id: first.areas[0].area_id },
      },
    });
    expect(correction.ok()).toBe(true);
    await openPanel(page, receiptUrl);
    const receipt = panel(page).getByRole("region", { name: "Saved observation", exact: true });
    await expect(receipt).toContainText("1,200.5 sq ft");
    await expect(receipt).toContainText("Revision 1");
    await expect(receipt).not.toContainText("1,250 sq ft");
    await expect(panel(page).getByText(/current area may have a later correction/)).toBeVisible();
    expect((await readSaved(page, manual)).areas[0].area_sq_ft).toBe(1250);
    expect(manual.commands).toHaveLength(1);
  });

  test("loads older history honestly and retains current readings when the next page fails", async ({
    page,
    manual,
  }) => {
    let head: string | null = null;
    for (let i = 0; i < 27; i += 1) {
      const result = await page.request.post(manual.endpoint, {
        headers: {
          "X-CSRF-Token": "estimator-acceptance-csrf",
          "Idempotency-Key": `manual-measurement:${randomUUID()}`,
        },
        data: {
          ...facts,
          expected_job_version: 1,
          expected_observation_head: head,
          target: { new_area_label: `Synthetic history area ${i + 1}` },
        },
      });
      expect(result.ok()).toBe(true);
      head = (await result.json()).receipt.observation.id;
    }
    let fail = true;
    await page.route(`**${manual.endpoint}?before=*`, (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: "synthetic_history_unavailable" } })
        : route.fallback(),
    );
    await openPanel(page, manual.path);
    const history = panel(page).getByRole("group", { name: "Observation history", exact: true });
    await history.locator("summary").click();
    await expect(history.locator("li")).toHaveCount(25);
    await history.getByRole("button", { name: "Load older observations", exact: true }).click();
    await expect(history.getByRole("alert")).toContainText(
      "History could not be loaded consistently",
    );
    await expect(history.locator("li")).toHaveCount(25);
    expect(manual.commands).toHaveLength(0);
    fail = false;
    await history.getByRole("button", { name: "Load older observations", exact: true }).click();
    await expect(history.locator("li")).toHaveCount(27);
    await expect(
      history.getByRole("button", { name: "Load older observations", exact: true }),
    ).toHaveCount(0);
  });

  test("refuses route and tenant-mismatched readbacks without allowing a save", async ({
    page,
    manual,
  }) => {
    let mismatch = "job";
    await page.route(`**${manual.endpoint}*`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const data = await response.json();
      if (mismatch === "job") data.job.id = "JOB-MANUAL-ANOTHER";
      else data.tenant_id = "another-tenant";
      return route.fulfill({ response, json: data });
    });
    await openPanel(page, manual.path);
    await expect(
      panel(page).getByText("Manual measurements could not be refreshed", { exact: true }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole("button", { name: "Save observation", exact: true }),
    ).toHaveCount(0);
    mismatch = "tenant";
    await page.reload();
    const roof = page.locator("summary").filter({ hasText: "Roof details" });
    await roof.click();
    await expect(
      panel(page).getByText("Manual measurements could not be refreshed", { exact: true }),
    ).toBeVisible();
    expect(manual.commands).toHaveLength(0);
  });

  test("sales can read observations but cannot record them", async ({ page, manual }) => {
    await page.route("**/api/v1/session", async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      session.user.role = "sales";
      return route.fulfill({ response, json: session });
    });
    await openPanel(page, manual.path);
    await expect(
      panel(page).getByText("Manual measurements are read-only", { exact: true }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole("button", { name: "Save observation", exact: true }),
    ).toHaveCount(0);
    expect(manual.commands).toHaveLength(0);
  });

  test("a field-role deep link cannot read or record estimator observations", async ({
    page,
    manual,
  }) => {
    await page.route("**/api/v1/session", async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      session.user.role = "field";
      return route.fulfill({ response, json: session });
    });
    await page.goto(manual.path);
    await expect(
      page.getByText("This work belongs to another role", { exact: true }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(manual.reads).toHaveLength(0);
    expect(manual.commands).toHaveLength(0);
  });

  test("owner without a job write grant cannot save; a failed fresh read does not restore authority", async ({
    page,
    manual,
  }) => {
    let readFails = false;
    await page.route(`**${manual.endpoint}*`, async (route) => {
      if (readFails)
        return route.fulfill({ status: 403, json: { error: "estimator_read_required" } });
      const response = await route.fetch();
      const data = await response.json();
      data.allowed_actions = [];
      return route.fulfill({ response, json: data });
    });
    await openPanel(page, manual.path);
    await expect(
      panel(page).getByText("Manual measurements are read-only", { exact: true }),
    ).toBeVisible();
    readFails = true;
    await panel(page).getByRole("button", { name: "Refresh measurements", exact: true }).click();
    await expect(
      panel(page).getByText("Manual measurements could not be refreshed", { exact: true }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole("button", { name: "Save observation", exact: true }),
    ).toHaveCount(0);
    expect(manual.commands).toHaveLength(0);
  });

  test("offline preserves the open draft but never queues a manual write", async ({
    page,
    context,
    manual,
  }) => {
    await openPanel(page, manual.path);
    await fillObservation(page);
    await context.setOffline(true);
    try {
      await expect(
        panel(page).getByText("Measurements are offline", { exact: true }),
      ).toBeVisible();
      await expect(
        panel(page).getByRole("button", { name: "Save observation", exact: true }),
      ).toBeDisabled();
      await expect(panel(page).getByLabel("Area label", { exact: true })).toHaveValue(
        "Synthetic north roof",
      );
      expect(manual.commands).toHaveLength(0);
    } finally {
      await context.setOffline(false);
    }
    await expect(
      panel(page).getByRole("button", { name: "Save observation", exact: true }),
    ).toBeEnabled();
    expect(manual.commands).toHaveLength(0);
  });

  test("manual entry, recovery, receipt and correction fit phone, tablet and desktop in both themes", async ({
    page,
    manual,
  }, testInfo) => {
    test.setTimeout(240_000);
    const capture = async (state: string, target: Locator) => {
      for (const width of [320, 390, 768, 1440])
        for (const colorScheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: width >= 768 ? 1024 : 844 });
          await page.emulateMedia({ colorScheme });
          await settleRendering(page);
          for (const control of await panel(page)
            .locator("button:visible,input:visible,select:visible,textarea:visible")
            .all())
            await expectTouchTarget(control, {
              name: (await control.getAttribute("aria-label")) ?? "manual measurement control",
              axis: "height",
            });
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
            ),
          ).toBe(true);
          expect(
            (
              await new AxeBuilder({ page })
                .include("main")
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze()
            ).violations,
          ).toEqual([]);
          await target.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${shotDir}/manual-${state}-${width}-${colorScheme}-${testInfo.project.name}.png`,
            animations: "disabled",
          });
        }
    };
    await openPanel(page, manual.path);
    await fillObservation(page, "SyntheticLongRoofReference".repeat(4));
    await panel(page)
      .getByRole("textbox", { name: "Uncertainty or limitations", exact: true })
      .fill("SyntheticUncertainty".repeat(23));
    await capture("entry", panel(page).getByLabel("Area label", { exact: true }));
    expect(manual.commands).toHaveLength(0);
    let failReceiptRead = true;
    await page.route(`**${manual.endpoint}*`, async (route) => {
      if (route.request().method() !== "POST") {
        if (new URL(route.request().url()).searchParams.has("request_id") && failReceiptRead) {
          failReceiptRead = false;
          return route.fulfill({
            status: 503,
            json: { error: "synthetic_receipt_temporarily_unavailable" },
          });
        }
        return route.fallback();
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
    });
    await panel(page).getByRole("button", { name: "Save observation", exact: true }).click();
    const check = panel(page).getByRole("button", { name: "Check saved observation", exact: true });
    await expect(check).toBeVisible();
    await capture("unknown", check);
    await check.click();
    const receipt = panel(page).getByRole("region", { name: "Saved observation", exact: true });
    await expect(receipt).toBeVisible();
    await capture("receipt", receipt);
    await panel(page)
      .getByRole("button", { name: "Record another observation", exact: true })
      .click();
    const current = panel(page).getByRole("region", { name: "Current observations", exact: true });
    await expect(current).toBeVisible();
    await capture("current", current);
    await panel(page)
      .getByRole("button", { name: /^Correct observation:/ })
      .click();
    await panel(page).getByLabel("Area (sq ft)", { exact: true }).fill("1240");
    const reason = panel(page).getByRole("textbox", { name: "Correction reason", exact: true });
    await reason.fill("Synthetic second tape check includes the north overhang.");
    await capture("correction", reason);
    expect(manual.commands).toHaveLength(1);
    expect((await readSaved(page, manual)).history.items).toHaveLength(1);
  });
});
