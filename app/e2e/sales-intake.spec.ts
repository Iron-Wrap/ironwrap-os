import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import {
  officeLeadReceiptResponseSchema,
  officeLeadRequestIdSchema,
  salesLeadDetailResponseSchema,
  type NewLeadInput,
  type OfficeLeadReadback,
  type OfficeLeadReceiptResponse,
} from "../src/sales/sales-contracts";
import { expectTouchTarget } from "./touch-target";

// Synthetic response fixtures verify UI behavior, not delivery to a live business system.
const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir =
  process.env.SALES_INTAKE_SCREENSHOT_DIR ?? "../output/p4-sales-intake-2026-09-30/after";
const requestId = "office-lead:ccba4715-4062-4d76-8656-2f11cf19eb0e";
const leadId = `lead:ironwrap:${"a".repeat(64)}`;
const capturedAt = "2026-09-30T12:00:00.000Z";
const commandRoute = /\/api\/v1\/sales\/leads\?include_receipt=1$/;
const receiptRoute = /\/api\/v1\/sales\/intakes\/[^/?]+$/;
const resumeRoute = /\/api\/v1\/sales\/intakes\/[^/?]+\/resume$/;
const detailRoute = (url: URL) =>
  decodeURIComponent(url.pathname) === `/api/v1/sales/leads/${leadId}`;
const receiptUrl = (id = requestId) => `/sales/new-lead?receipt=${encodeURIComponent(id)}`;

function details(): OfficeLeadReadback {
  return {
    name: "Synthetic Jordan Vale",
    email: "jordan@example.invalid",
    phone: "+14035550123",
    address: "123 Synthetic Roof Lane",
    city: "Edmonton",
    province: "AB",
    postal_code: "T5J 0N3",
    service: "Synthetic roof repair",
    message:
      "Synthetic caller reports a loose roof edge. Confirm the details before any commitment.",
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
  };
}

function recorded(id = requestId): OfficeLeadReceiptResponse {
  return officeLeadReceiptResponseSchema.parse({
    version: 1,
    receipt: {
      request_id: id,
      state: "recorded",
      outcome: "created",
      canonical_envelope_id: "ow_synthetic-p4-intake-001",
      lead_id: leadId,
      submitted_details_applied: true,
      captured_at: capturedAt,
      details: details(),
    },
  });
}

function processing(id = requestId): OfficeLeadReceiptResponse {
  return officeLeadReceiptResponseSchema.parse({
    version: 1,
    receipt: {
      request_id: id,
      state: "processing",
      outcome: null,
      canonical_envelope_id: null,
      lead_id: null,
      submitted_details_applied: null,
      captured_at: capturedAt,
      details: null,
    },
  });
}

function leadDetail() {
  return salesLeadDetailResponseSchema.parse({
    version: 1,
    read_model_generated_at: capturedAt,
    permissions: ["sales:read"],
    allowed_actions: ["sales.read", "commercial.lead_triage.record"],
    stale_fields: [],
    partial_sources: [],
    lead: {
      id: leadId,
      envelope_id: "ow_synthetic-p4-intake-001",
      source: "office",
      received_at: capturedAt,
      transport_status: "received",
      intent_queue: "Estimator",
      contact: { display_name: details().name, email: details().email, phone: details().phone },
      triage: { status: "Untriaged", summary: null, version: 1 },
      job: null,
      estimate: null,
      quote: null,
      proposal: null,
      consent: { context: "no_linked_record", records: [] },
      partial_fields: [],
      attention: ["triage_unresolved"],
    },
    intake: details(),
  });
}

async function installIntake(page: Page, initial = recorded()) {
  const state = {
    response: initial,
    postOutcome: "reply" as "reply" | "lost_ack" | "refused",
    resumeOutcome: "reply" as "reply" | "lost_ack",
    readStatus: 200,
    commands: [] as Array<{ key: string; body: NewLeadInput }>,
    receiptReads: [] as string[],
    resumes: [] as Array<{ id: string; body: unknown; key?: string }>,
    detailReads: 0,
  };
  await page.route(commandRoute, async (route) => {
    expect(route.request().method()).toBe("POST");
    const key = officeLeadRequestIdSchema.parse(route.request().headers()["idempotency-key"]);
    state.commands.push({ key, body: route.request().postDataJSON() as NewLeadInput });
    state.response.receipt.request_id = key;
    if (state.postOutcome === "lost_ack") return route.abort("failed");
    if (state.postOutcome === "refused")
      return route.fulfill({ status: 403, json: { error: "sales_lead_create_required" } });
    return route.fulfill({
      status: 202,
      json: officeLeadReceiptResponseSchema.parse(state.response),
    });
  });
  await page.route(receiptRoute, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    officeLeadRequestIdSchema.parse(id);
    state.receiptReads.push(id);
    if (state.readStatus !== 200)
      return route.fulfill({
        status: state.readStatus,
        json: { error: "office_lead_receipt_not_found" },
      });
    return route.fulfill({ json: officeLeadReceiptResponseSchema.parse(state.response) });
  });
  await page.route(detailRoute, (route) => {
    state.detailReads += 1;
    return route.fulfill({ json: leadDetail() });
  });
  await page.route(resumeRoute, (route) => {
    const request = route.request();
    const id = officeLeadRequestIdSchema.parse(
      decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2)!),
    );
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-csrf-token"]).toBeTruthy();
    state.resumes.push({
      id,
      body: request.postDataJSON(),
      key: request.headers()["idempotency-key"],
    });
    if (state.resumeOutcome === "lost_ack") return route.abort("failed");
    return route.fulfill({ json: officeLeadReceiptResponseSchema.parse(state.response) });
  });
  return state;
}

async function fillMinimum(page: Page) {
  await page.getByLabel("Full name", { exact: true }).fill(details().name);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(details().email!);
}

async function assertNoContactStorage(page: Page) {
  const stored = await page.evaluate(() =>
    [JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join(" "),
  );
  for (const value of [details().name, details().email, details().phone, details().message]) {
    expect(stored).not.toContain(value);
  }
  expect(page.url()).not.toContain("jordan");
}

async function settleTheme(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

const test = base.extend<{ intakeOnlyWrites: void }>({
  intakeOnlyWrites: [
    async ({ page }, use) => {
      const unexpected: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          !url.pathname.startsWith("/api/") ||
          ["GET", "HEAD", "OPTIONS"].includes(request.method())
        )
          return;
        const create =
          url.pathname === "/api/v1/sales/leads" && url.search === "?include_receipt=1";
        const resume = resumeRoute.test(url.pathname) && !url.search;
        if (request.method() !== "POST" || (!create && !resume))
          unexpected.push(`${request.method()} ${url.pathname}`);
      });
      await page.route("**/api/**", (route) =>
        ["GET", "HEAD", "OPTIONS"].includes(route.request().method())
          ? route.fallback()
          : route.fulfill({ status: 409, json: { error: "unexpected_ui_command" } }),
      );
      await use();
      expect(
        unexpected,
        "Intake browsing must never send messages, book visits, or execute other commands",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

test.describe("P4 sales intake browser evidence", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");
  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("records source details, reloads the receipt, and opens the exact lead for review", async ({
    page,
  }, testInfo) => {
    const state = await installIntake(page);
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByRole("textbox", { name: "Phone", exact: true }).fill(details().phone!);
    await page.getByLabel(/^What they need/).fill(details().message!);
    await page.getByLabel(/^Kind of work/).fill(details().service!);
    await page
      .getByRole("group", { name: "How they prefer to be contacted" })
      .getByRole("radio", { name: "Phone", exact: true })
      .check();
    await expect(page.getByRole("checkbox", { name: /They agreed/ })).not.toBeChecked();
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]!.body).toMatchObject({
      name: details().name,
      email: details().email,
      phone: details().phone,
      message: details().message,
      service: details().service,
      intake_source: "phone",
      preferred_contact_channel: "phone",
      email_estimate_follow_up_consent: false,
    });
    expect(new URL(page.url()).searchParams.get("receipt")).toBe(state.commands[0]!.key);
    await assertNoContactStorage(page);
    await page.reload();
    await expect(page.getByRole("region", { name: "Saved lead details" })).toContainText(
      details().message!,
    );
    expect(state.receiptReads).toContain(state.commands[0]!.key);
    expect(state.commands).toHaveLength(1);
    await settleTheme(page);
    await page.screenshot({
      path: `${shotDir}/intake-receipt-focused-viewport-${testInfo.project.name}.png`,
    });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await settleTheme(page);
    await page.screenshot({
      path: `${shotDir}/intake-receipt-top-viewport-${testInfo.project.name}.png`,
    });
    await page.screenshot({
      path: `${shotDir}/intake-receipt-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "Review this lead", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Lead review", exact: true })).toBeVisible();
    expect(state.detailReads).toBeGreaterThan(0);
    expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/sales/leads/${leadId}/triage`);
    expect(state.commands).toHaveLength(1);
  });

  test("keeps processing separate from recorded and checks the same intent without another write", async ({
    page,
  }) => {
    const state = await installIntake(page, processing());
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("This intake is still processing", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review this lead" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add another lead" })).toHaveCount(0);
    const id = state.commands[0]!.key;
    state.response = recorded(id);
    await page.getByRole("button", { name: "Check saved result", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    expect(state.receiptReads).toEqual([id]);
    expect(state.commands).toHaveLength(1);
    expect(state.resumes).toHaveLength(0);
  });

  test("resumes a persisted processing intake after reload only through an explicit same-receipt command", async ({
    page,
  }) => {
    const state = await installIntake(page, processing());
    await page.goto(receiptUrl());
    await expect(page.getByText("This intake is still processing", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toBeEnabled();
    expect(state.commands).toHaveLength(0);
    expect(state.resumes).toHaveLength(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toBeEnabled();
    expect(state.receiptReads).toEqual([requestId, requestId]);
    expect(state.resumes).toHaveLength(0);
    await expect(page.getByLabel("Full name", { exact: true })).toHaveCount(0);
    state.response = recorded();
    await page.getByRole("button", { name: "Resume saved intake", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    expect(state.resumes).toEqual([{ id: requestId, body: {}, key: undefined }]);
    expect(state.commands).toHaveLength(0);
    expect(new URL(page.url()).searchParams.get("receipt")).toBe(requestId);
    await assertNoContactStorage(page);
  });

  test("checks the same receipt after a lost resume acknowledgement without automatically resuming again", async ({
    page,
  }) => {
    const state = await installIntake(page, processing());
    await page.goto(receiptUrl());
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toBeEnabled();
    state.response = recorded();
    state.resumeOutcome = "lost_ack";
    await page.getByRole("button", { name: "Resume saved intake", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Check saved result", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Lead intake recorded", { exact: true })).toHaveCount(0);
    expect(state.resumes).toEqual([{ id: requestId, body: {}, key: undefined }]);
    await page.getByRole("button", { name: "Check saved result", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    expect(state.receiptReads).toEqual([requestId, requestId]);
    expect(state.resumes).toHaveLength(1);
    expect(state.commands).toHaveLength(0);
  });

  test("does not invent a lead link before the recorded intake has a lead projection", async ({
    page,
  }) => {
    const response = recorded();
    response.receipt.lead_id = null;
    const state = await installIntake(page, response);
    await page.goto(receiptUrl());
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await expect(page.getByText(/lead is not ready for review yet/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Review this lead" })).toHaveCount(0);
    state.response = recorded();
    await page.getByRole("button", { name: "Check saved result", exact: true }).click();
    await expect(page.getByRole("link", { name: "Review this lead", exact: true })).toHaveAttribute(
      "href",
      `/sales/leads/${encodeURIComponent(leadId)}/triage`,
    );
    expect(state.commands).toHaveLength(0);
  });

  test("shows canonical duplicate details without claiming the new consent or notes were applied", async ({
    page,
  }) => {
    const response = recorded();
    response.receipt.outcome = "duplicate";
    response.receipt.submitted_details_applied = false;
    response.receipt.details!.name = "Synthetic Existing Jordan";
    response.receipt.details!.message = "Earlier canonical notes retained.";
    const state = await installIntake(page, response);
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page
      .getByLabel(/^What they need/)
      .fill("New notes must not replace the existing intake.");
    await page.getByRole("checkbox", { name: /They agreed/ }).check();
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("An existing lead was found", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/submitted details, contact preference and email permission were not applied/),
    ).toBeVisible();
    const canonical = page.getByRole("region", { name: "Existing lead details" });
    await expect(canonical).toContainText("Earlier canonical notes retained.");
    await expect(canonical).toContainText("No estimate follow-up permission recorded");
    await expect(canonical).not.toContainText("New notes must not replace");
    expect(state.commands[0]!.body.email_estimate_follow_up_consent).toBe(true);
    expect(state.commands).toHaveLength(1);
  });

  test("recovers a lost acknowledgement through receipt reads, including an initial missing receipt", async ({
    page,
  }) => {
    const state = await installIntake(page);
    state.postOutcome = "lost_ack";
    state.readStatus = 404;
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(
      page.getByText("We haven’t confirmed whether this lead was saved", { exact: true }),
    ).toBeVisible();
    const id = state.commands[0]!.key;
    await page.getByRole("button", { name: "Check saved result", exact: true }).click();
    await expect(page.getByText(/does not confirm that the lead was not saved/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toHaveCount(0);
    await assertNoContactStorage(page);
    state.readStatus = 200;
    await page.reload();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toHaveCount(
      0,
    );
    expect(state.receiptReads).toEqual([id, id]);
    expect(state.commands).toHaveLength(1);
    expect(state.resumes).toHaveLength(0);
  });

  test("retries only explicitly after checking, using the unchanged input and request identity", async ({
    page,
  }) => {
    const state = await installIntake(page);
    state.postOutcome = "lost_ack";
    state.readStatus = 404;
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByLabel(/^What they need/).fill(details().message!);
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(
      page.getByText("We haven’t confirmed whether this lead was saved", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toHaveCount(
      0,
    );
    expect(state.commands).toHaveLength(1);
    await page.getByRole("button", { name: "Check saved result", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retry same request", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveCount(0);
    expect(state.commands).toHaveLength(1);
    state.postOutcome = "reply";
    state.readStatus = 200;
    await page.getByRole("button", { name: "Retry same request", exact: true }).click();
    await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
    expect(state.commands).toHaveLength(2);
    expect(state.commands[1]).toEqual(state.commands[0]);
  });

  test("cannot retry unknown delivery after reload when the original input is no longer held", async ({
    page,
  }) => {
    const state = await installIntake(page);
    state.postOutcome = "lost_ack";
    state.readStatus = 404;
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(
      page.getByText("We haven’t confirmed whether this lead was saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText(/does not confirm that the lead was not saved/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resume saved intake", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toHaveCount(0);
    await assertNoContactStorage(page);
    expect(state.commands).toHaveLength(1);
    expect(state.resumes).toHaveLength(0);
  });

  test("retains form details after a definite refusal and does not call it a saved lead", async ({
    page,
  }) => {
    const state = await installIntake(page);
    state.postOutcome = "refused";
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page).toHaveURL(/\/sales\/new-lead$/);
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeVisible();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(details().name);
    await expect(page.getByText("Lead intake recorded", { exact: true })).toHaveCount(0);
    expect(state.commands).toHaveLength(1);
    expect(state.receiptReads).toHaveLength(0);
  });

  test("requires a usable preferred channel and explicit email follow-up consent", async ({
    page,
  }) => {
    const state = await installIntake(page);
    await page.goto("/sales/new-lead");
    await page.getByLabel("Full name", { exact: true }).fill(details().name);
    await page.getByRole("textbox", { name: "Phone", exact: true }).fill(details().phone!);
    await page
      .getByRole("group", { name: "How they prefer to be contacted" })
      .getByRole("radio", { name: "Email", exact: true })
      .check();
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(details().email!);
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: /They agreed/ })).not.toBeChecked();
    await page.getByRole("checkbox", { name: /They agreed/ }).check();
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("");
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeDisabled();
    expect(state.commands).toHaveLength(0);
  });

  test("does not submit or check a receipt while the connection is offline", async ({ page }) => {
    const state = await installIntake(page);
    await page.goto("/sales/new-lead");
    await fillMinimum(page);
    await page.context().setOffline(true);
    await expect(
      page.getByText("Reconnect before saving or checking a lead", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeDisabled();
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Save lead", exact: true })).toBeEnabled();
    state.response = processing();
    await page.getByRole("button", { name: "Save lead", exact: true }).click();
    await expect(page.getByText("This intake is still processing", { exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await expect(
      page.getByRole("button", { name: "Check saved result", exact: true }),
    ).toBeDisabled();
    expect(state.commands).toHaveLength(1);
    expect(state.receiptReads).toHaveLength(0);
  });

  test("does not offer a write when the live session lacks lead creation authority", async ({
    page,
  }) => {
    const state = await installIntake(page);
    await page.route("**/api/v1/session", async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      session.allowed_actions = session.allowed_actions.filter(
        (action: string) => action !== "sales.lead.create",
      );
      await route.fulfill({ response, json: session });
    });
    await page.goto("/sales/new-lead");
    await expect(page.getByRole("heading", { name: "Add a lead", exact: true })).toBeVisible();
    const save = page.getByRole("button", { name: "Save lead", exact: true });
    await expect(save).toBeDisabled();
    expect(state.commands).toHaveLength(0);
  });

  test("fits the form and long recorded details at 320 and 390 in both themes", async ({
    page,
  }, testInfo) => {
    const response = recorded();
    response.receipt.details!.message = "SyntheticRoofReference".repeat(45);
    response.receipt.details!.address = "SyntheticLongAddress".repeat(9);
    const state = await installIntake(page, response);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const screen of ["form", "receipt"] as const) {
          await page.goto(screen === "form" ? "/sales/new-lead" : receiptUrl());
          await expect(
            page.getByRole("heading", { name: "Add a lead", exact: true }),
          ).toBeVisible();
          if (screen === "receipt")
            await expect(page.getByText("Lead intake recorded", { exact: true })).toBeVisible();
          await settleTheme(page);
          const overflow = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            content: document.documentElement.scrollWidth,
          }));
          expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
          const controls = page.locator(
            "main button:visible, main a:visible, main input:not([type=radio]):not([type=checkbox]):visible, main textarea:visible, main .new-lead-choice, main .new-lead-consent",
          );
          for (const control of await controls.all())
            await expectTouchTarget(control, {
              name: (await control.textContent())?.trim().slice(0, 50) || "form control",
              axis: "height",
            });
          expect(
            (
              await new AxeBuilder({ page })
                .include("main")
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze()
            ).violations,
          ).toEqual([]);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({
            path: `${shotDir}/intake-${screen}-${width}-${colorScheme}-${testInfo.project.name}.png`,
            fullPage: true,
          });
        }
      }
    }
    expect(state.commands).toHaveLength(0);
  });

  test("keeps every phone form control reachable above the sticky save bar", async ({
    page,
  }, testInfo) => {
    const state = await installIntake(page);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto("/sales/new-lead");
        await expect(page.getByRole("heading", { name: "Add a lead", exact: true })).toBeVisible();
        await settleTheme(page);
        await page.screenshot({
          path: `${shotDir}/intake-form-top-viewport-${width}-${colorScheme}-${testInfo.project.name}.png`,
        });
        const controls = page.locator(
          ".new-lead-sheet input:not([type=radio]):not([type=checkbox]), .new-lead-sheet textarea, .new-lead-choice, .new-lead-consent",
        );
        for (const control of await controls.all()) {
          await control.evaluate((element) =>
            element.scrollIntoView({ block: "center", behavior: "instant" }),
          );
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const geometry = await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const header = document.querySelector(".shell-topbar")!.getBoundingClientRect();
            const footer = document.querySelector(".new-lead-footer")!.getBoundingClientRect();
            const atCenter = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return {
              name: element.getAttribute("name") || element.textContent?.trim(),
              top: box.top,
              bottom: box.bottom,
              headerBottom: header.bottom,
              footerTop: footer.top,
              receivesPointer: atCenter === element || element.contains(atCenter),
            };
          });
          expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
            geometry.headerBottom - 1,
          );
          expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
            geometry.footerTop + 1,
          );
          expect(geometry.receivesPointer, JSON.stringify(geometry)).toBe(true);
        }
        await page.getByRole("checkbox", { name: /They agreed/ }).check();
        await expect(page.getByRole("checkbox", { name: /They agreed/ })).toBeChecked();
        await page.screenshot({
          path: `${shotDir}/intake-consent-viewport-${width}-${colorScheme}-${testInfo.project.name}.png`,
        });
        await page.getByRole("radio", { name: "Walk-in", exact: true }).check();
        await expect(page.getByRole("radio", { name: "Walk-in", exact: true })).toBeChecked();
        await page.screenshot({
          path: `${shotDir}/intake-form-bottom-viewport-${width}-${colorScheme}-${testInfo.project.name}.png`,
        });
      }
    }
    expect(state.commands).toHaveLength(0);
  });
});
