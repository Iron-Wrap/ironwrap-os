import { mkdir, writeFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import type { JobGatesResponse } from "../src/production/gates/gate-contracts";
import { settleAnimations } from "./settle";
import {
  CONTRACT_SIGNED_AT,
  ENDED_NOW,
  JOB_ID,
  OPEN_NOW,
  clearedGate,
  crews,
  entry,
  gate,
  materialsProof,
  model,
  queue,
  readyToSchedule,
  request,
  runwayJob,
  windowState,
} from "../src/production/gates/gate-test-fixtures";

/**
 * The office's gate flows (PR-C) in a built browser, against the gate train's real contracts:
 * the reads and writes are served here from synthetic fixtures on one timeline, so each test
 * owns its state. Each flow ends with an axe check for WCAG 2 A and AA.
 *
 * With PR_C_SHOTS_DIR set, the last test also writes the built-UI screens for the Z1 gate: one
 * PNG per P30 frame at 1440×1000 in light, at rest at the top (and fully scrolled when the page
 * scrolls), with every visible string next to it.
 */

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotsDir = process.env.PR_C_SHOTS_DIR;

test.use({ timezoneId: "America/Edmonton", locale: "en-CA", colorScheme: "light" });

const tenant = {
  id: "ironwrap",
  name: "IronWrap Exteriors",
  brand: "IronWrap Exteriors",
  locale: "en-CA",
  time_zone: "America/Edmonton",
  currency: "CAD",
};

function sessionFor(role: "owner" | "ops" | "production") {
  return {
    version: 1,
    source_updated_at: "2026-10-21T16:45:00.000Z",
    read_model_generated_at: "2026-10-21T16:45:01.000Z",
    stale_fields: [],
    permissions: ["production:read"],
    allowed_actions: ["job.read", "production.read"],
    authenticated: true,
    user: {
      id: `appu_${role}_synthetic`,
      email: `${role}.gates@example.invalid`,
      display_name: role === "owner" ? "Dana Whitford" : "Tom Lachance",
      role,
      frappe_user_id: null,
    },
    tenant,
    csrf_token: "gates-acceptance-csrf",
    session_expires_at: "2030-01-01T00:00:00.000Z",
  };
}

const runway = {
  version: 1,
  source_updated_at: "2026-10-21T16:45:00.000Z",
  read_model_generated_at: "2026-10-21T16:45:01.000Z",
  stale_fields: [],
  permissions: ["production:read"],
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
  jobs: [runwayJob],
  crews,
};

const history = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-10-21T16:45:01.000Z",
  stale_fields: [],
  permissions: [],
  allowed_actions: [],
  job: {
    id: JOB_ID,
    roof_job_id: JOB_ID,
    job_number: "IW-2041",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "Won",
    address: "118 Larkspur Way NW, Calgary AB, Canada",
    current_gate_state: null,
  },
  customer: { display_name: "Elena Marchetti", phone: null },
  gates: [],
  proof: { items: [], next_cursor: null },
  openable: true,
  proof_unavailable: false,
};

interface Office {
  gates: JobGatesResponse;
  posts: Array<{ path: string; body: unknown }>;
  answer: (path: string, body: unknown) => { status: number; json: unknown };
}

async function office(
  page: Page,
  options: {
    role?: "owner" | "ops" | "production";
    gates: JobGatesResponse;
    now: Date;
    answer?: Office["answer"];
  },
): Promise<Office> {
  const state: Office = {
    gates: options.gates,
    posts: [],
    answer: options.answer ?? (() => ({ status: 500, json: { error: "not_stubbed" } })),
  };
  await page.clock.setFixedTime(options.now);
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: sessionFor(options.role ?? "owner") }),
  );
  await page.route("**/api/v1/production", (route) => route.fulfill({ json: runway }));
  await page.route(`**/api/v1/jobs/${JOB_ID}/history*`, (route) =>
    route.fulfill({ json: history }),
  );
  await page.route("**/api/v1/production/cancellation-window/signed-copy-missing", (route) =>
    route.fulfill({ json: queue }),
  );
  await page.route(`**/api/v1/production/jobs/${JOB_ID}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.endsWith("/gates")) {
      await route.fulfill({ json: state.gates });
      return;
    }
    const body = request.postDataJSON() as unknown;
    state.posts.push({ path, body });
    const reply = state.answer(path, body);
    await route.fulfill({ status: reply.status, json: reply.json });
  });
  return state;
}

async function expectAccessible(page: Page) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
}

const gatesUrl = (step?: string) =>
  `/production/jobs/${JOB_ID}/gates${step ? `?step=${step}` : ""}`;

test.describe("Job gates acceptance (PR-C)", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test("Safety clears with its proof while the window is open, and the list follows", async ({
    page,
  }) => {
    const state = await office(page, {
      role: "production",
      gates: model("open"),
      now: OPEN_NOW,
      answer: (path, body) => {
        state.gates = model("open", {
          Safety: clearedGate(
            "Safety",
            (body as { attestation: Record<string, unknown> }).attestation,
            null,
            OPEN_NOW.toISOString(),
          ),
        });
        return {
          status: 200,
          json: {
            entry: state.gates.gates[2]!.entries[0],
            gate: {
              name: "gate:safety",
              gate: "Safety",
              roof_job: JOB_ID,
              state: "ready",
              version: 2,
            },
            replayed: false,
          },
        };
      },
    });
    await page.goto(gatesUrl());
    await expect(page.getByRole("heading", { name: "Gates" })).toBeVisible();
    await expect(page.getByText("0 of 5 gates cleared · 4 blocked · 1 waiting")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Schedule the crew · after the window ends" }),
    ).toBeDisabled();
    await expectAccessible(page);

    await page.getByRole("link", { name: "Clear Safety" }).click();
    await expect(page.getByRole("heading", { name: "Safety" })).toBeVisible();
    await page.getByLabel("Hazard assessment").fill("4417");
    await page.getByLabel("When it was done").fill("2026-10-21T10:40");
    await page.getByRole("radio", { name: "Permit needed and held" }).check();
    await page.getByLabel("Permit number").fill("building permit 4417");
    await page.getByRole("radio", { name: "No exposure at 3 m" }).check();
    await expectAccessible(page);
    await page.getByRole("button", { name: "Clear Safety with this proof" }).click();

    await expect(page.getByText("Cleared Today 10:45 by production")).toBeVisible();
    expect(state.posts[0]?.path).toBe(`/api/v1/production/jobs/${JOB_ID}/gates/Safety/clearance`);
    expect(state.posts[0]?.body).toEqual({
      basis: "person_attestation",
      expected_gate_version: 1,
      attestation: {
        hazard_assessment_ref: "4417",
        permit: { answer: "needed_and_held", number: "building permit 4417" },
        fall_protection: { no_exposure_at_3m: true },
        assessed_at: "2026-10-21T16:40:00.000Z",
      },
    });
    await page.getByRole("link", { name: "Elena Marchetti · 118 Larkspur Way NW" }).click();
    await expect(page.getByText("1 of 5 gates cleared · 3 blocked · 1 waiting")).toBeVisible();
  });

  test("the owner records when the signed copy was received; the window then shows its last day", async ({
    page,
  }) => {
    const state = await office(page, {
      role: "owner",
      gates: model("unknown"),
      now: OPEN_NOW,
      answer: () => {
        state.gates = model("open");
        return {
          status: 201,
          json: {
            cancellation_window: windowState("open", {
              signed_copy_received: {
                ...windowState("open").signed_copy_received!,
                recorded_at: OPEN_NOW.toISOString(),
              },
            }),
            recorded: true,
            receipt_id: "pcw_synthetic",
            replayed: false,
          },
        };
      },
    });
    await page.goto(gatesUrl());
    await expect(
      page.getByText(
        "No one has recorded when Elena Marchetti received the signed copy of the contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      ),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Add when Elena Marchetti received the signed copy" })
      .click();
    await expect(page.getByText("Contract signed Tue 20 Oct 18:20")).toBeVisible();
    await page.getByLabel("Signed copy received").fill("2026-10-20T18:26");
    await page
      .getByLabel("Why are you recording it?")
      .fill(
        "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
      );
    await page
      .getByLabel("Evidence (a reference or a file)")
      .fill("Delivered email · signed copy.pdf");
    await expectAccessible(page);
    await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();

    await expect(
      page.getByText("Recorded. The cancellation window is open until the end of Fri 30 Oct."),
    ).toBeVisible();
    await expect(page.getByText("Tue 20 Oct 18:26 · recorded Today 10:45 by you")).toBeVisible();
    expect(state.posts[0]).toEqual({
      path: `/api/v1/production/jobs/${JOB_ID}/cancellation-window/signed-copy`,
      body: {
        received_at: "2026-10-20T18:26:00-06:00",
        reason:
          "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
        evidence_ref: "Delivered email · signed copy.pdf",
      },
    });
    await expectAccessible(page);
  });

  test("production never sees the record step's control, whatever the window says", async ({
    page,
  }) => {
    await office(page, { role: "production", gates: model("unknown"), now: OPEN_NOW });
    await page.goto(gatesUrl("window"));
    await expect(
      page.getByText(
        "Only an owner or ops can record when Elena Marchetti received the signed copy.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Record when/ })).toHaveCount(0);
    await expect(page.getByLabel("Signed copy received")).toHaveCount(0);
  });

  test("production asks the owner to waive Materials and waits on the answer", async ({ page }) => {
    const state = await office(page, {
      role: "production",
      gates: model("ended"),
      now: ENDED_NOW,
      answer: () => {
        state.gates = model("ended", {
          Materials: gate("Materials", {
            version: 2,
            open_waiver_requests: [request({ created_at: ENDED_NOW.toISOString() })],
          }),
        });
        return { status: 409, json: { error: "production_gate_waiver_requested" } };
      },
    });
    await page.goto(gatesUrl("waive-materials"));
    await page
      .getByLabel("Why waive Materials?")
      .fill("The shingles are at our yard. The supplier sends the reference this afternoon.");
    await page.getByRole("button", { name: "Ask the owner to waive Materials" }).click();
    await page.goto(gatesUrl("materials"));
    await expect(
      page.getByText(
        "Your request is recorded, today at 10:45. An owner decides; Materials stays blocked until then.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Materials waiting on the owner", { exact: false })).toBeVisible();
    await expectAccessible(page);
  });

  test("ops opens the work queue and each row opens that job's record step", async ({ page }) => {
    await office(page, { role: "ops", gates: model("unknown"), now: OPEN_NOW });
    await page.goto("/production/signed-copy-missing");
    await expect(page.getByText("Jobs with no signed-copy time: 3")).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("link", { name: "Add the signed-copy time for Elena Marchetti" }).click();
    await expect(page.getByRole("heading", { name: "Cancellation window" })).toBeVisible();
    await expect(page.getByText(/and you’re in operations\./)).toBeVisible();
  });

  test("a reversal keeps the clearance in the history and sends Materials back to blocked", async ({
    page,
  }) => {
    const cleared = clearedGate("Materials", materialsProof, "Prairie Coil Supply");
    const state = await office(page, {
      role: "production",
      gates: model("ended", { Materials: cleared }),
      now: ENDED_NOW,
      answer: (_path, body) => {
        const reversal = entry({
          from_gate_version: 2,
          kind: "reverse",
          basis: "person_reversal",
          to_state: "blocked",
          reason: (body as { reason: string }).reason,
          created_at: ENDED_NOW.toISOString(),
        });
        state.gates = model("ended", {
          Materials: gate("Materials", { version: 3, entries: [cleared.entries[0]!, reversal] }),
        });
        return {
          status: 200,
          json: {
            entry: reversal,
            gate: {
              name: "gate:materials",
              gate: "Materials",
              roof_job: JOB_ID,
              state: "blocked",
              version: 3,
            },
            replayed: false,
          },
        };
      },
    });
    await page.goto(gatesUrl("materials"));
    await page
      .getByLabel("Why reverse it?")
      .fill("Order 3140 is another job’s. Elena’s order is 3152.");
    await page.getByRole("button", { name: "Reverse the clearance with this reason" }).click();
    await expect(
      page.getByText("Reversed today at 10:45. Materials is blocked again. Nothing was deleted."),
    ).toBeVisible();
    await expect(page.getByText("Today 08:40 · Cleared")).toBeVisible();
    await expectAccessible(page);
  });

  test("built-UI screens for the Z1 gate", async ({ page }) => {
    test.skip(!shotsDir, "set PR_C_SHOTS_DIR to write the built-UI screens");
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mkdir(shotsDir!, { recursive: true });
    const index: Array<{
      file: string;
      frame: string;
      title: string;
      position: string;
      text: string;
    }> = [];

    const capture = async (name: string, frame: string, title: string) => {
      // At rest: nothing focused, no animation running, scrolled to the top.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settleAnimations(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const text = await page.locator("main").first().innerText();
      const top = `${name}-top.png`;
      await page.screenshot({ path: `${shotsDir}/${top}` });
      index.push({ file: top, frame, title, position: "top", text });
      const scrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 2,
      );
      if (scrolls) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(150);
        const bottom = `${name}-bottom.png`;
        await page.screenshot({ path: `${shotsDir}/${bottom}` });
        index.push({ file: bottom, frame, title, position: "fully scrolled", text: "" });
      }
    };

    const ready = readyToSchedule();
    const endedBlocked = (overrides: Parameters<typeof model>[1] = {}) => model("ended", overrides);
    const visit = async (
      gates: JobGatesResponse,
      step: string | undefined,
      role: "owner" | "ops" | "production",
      now: Date,
      answer?: Office["answer"],
    ) => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const state = await office(page, { role, gates, now, answer });
      await page.goto(gatesUrl(step));
      await expect(page.locator("main h1")).toBeVisible();
      return state;
    };
    const refuse =
      (error: string, extra: Record<string, unknown> = {}) =>
      () => ({
        status: error.includes("competency") || error.includes("crew") ? 403 : 409,
        json: { error, ...extra },
      });
    const fillSafety = async (permit: string) => {
      await page.getByLabel("Hazard assessment").fill("4417");
      await page.getByLabel("When it was done").fill("2026-10-21T10:40");
      await page.getByRole("radio", { name: permit }).check();
      if (permit === "Permit needed and held") {
        await page.getByLabel("Permit number").fill("building permit 4417");
      }
      await page.getByRole("radio", { name: "Fall-protection plan" }).check();
      await page.getByRole("textbox", { name: "Fall-protection plan" }).fill("ridge-anchors-2");
    };
    const fillRecord = async (time: string, label = "Signed copy received") => {
      await page.getByLabel(label).fill(time);
      await page
        .getByLabel("Why are you recording it?")
        .fill(
          "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
        );
      await page
        .getByLabel("Evidence (a reference or a file)")
        .fill("Delivered email · signed copy.pdf");
    };
    const waived = (name: "Materials" | "Access") =>
      gate(name, {
        state: "waived",
        version: 2,
        entries: [
          entry({
            from_gate_version: 1,
            kind: "waiver_decision",
            basis: "office_waiver",
            to_state: "waived",
            actor_role: "owner",
            created_at: "2026-11-02T14:40:00.000Z",
          }),
        ],
      });

    // 1 · overview, window open.
    await visit(model("open"), undefined, "production", OPEN_NOW);
    await capture("01-overview", "1322:4947", "1 · Gate overview");
    // 2 · Materials held by the window.
    await visit(model("open"), "materials", "production", OPEN_NOW);
    await capture(
      "02-materials-held",
      "1322:5001",
      "2 · Materials · held by the cancellation window",
    );
    // 3 · Materials, clear with proof.
    await visit(
      endedBlocked({ Safety: ready.gates[2], Access: ready.gates[3] }),
      "materials",
      "production",
      ENDED_NOW,
    );
    await page.getByLabel("Supplier", { exact: true }).fill("Prairie Coil Supply");
    await page.getByLabel("Supplier reference").fill("3152");
    await capture("03-materials-proof", "1322:5030", "3 · Materials · clear with proof");
    // 4 · Safety, clear with proof.
    await visit(model("open"), "safety", "production", OPEN_NOW);
    await fillSafety("Permit needed and held");
    await capture("04-safety-proof", "1322:5059", "4 · Safety · clear with proof");
    // 5 · Access.
    await visit(model("open", { Safety: ready.gates[2] }), "access", "production", OPEN_NOW);
    await page.getByRole("radio", { name: "The customer" }).check();
    await page.getByLabel("When", { exact: true }).fill("2026-10-21T10:30");
    await page
      .getByLabel("What they confirmed")
      .fill("Side gate unlocked on the crew days; driveway clear for the bin");
    await capture("05-access-proof", "1322:5098", "5 · Access · clear with proof");
    // 6 · Weather.
    await visit(
      endedBlocked({ Materials: ready.gates[1], Safety: ready.gates[2], Access: ready.gates[3] }),
      "weather",
      "production",
      ENDED_NOW,
    );
    await page.getByLabel("Work window starts").fill("2026-11-03T07:00");
    await page.getByLabel("Work window ends").fill("2026-11-04T17:00");
    await page.getByLabel("Forecast", { exact: true }).fill("Dry, wind under 30 km/h");
    await page.getByLabel("When you read it").fill("2026-11-02T06:00");
    await page.getByLabel("Where you read it").fill("weather.gc.ca");
    await capture("06-weather-proof", "1322:5132", "6 · Weather · clear with proof");
    // 7 · Crew, not yet.
    await visit(ready, "crew", "production", ENDED_NOW);
    await capture("07-crew-not-yet", "1322:5161", "7 · Crew · not yet");
    // 7b · Crew cleared at scheduling.
    {
      const crewGate = gate("Crew", {
        state: "complete",
        version: 2,
        entries: [
          entry({
            from_gate_version: 1,
            basis: "crew_assignment",
            to_state: "complete",
            actor_role: null,
            created_at: "2026-11-02T16:05:00.000Z",
          }),
        ],
      });
      const scheduled = {
        ...ready,
        gates: ready.gates.map((candidate) => (candidate.gate === "Crew" ? crewGate : candidate)),
      };
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await office(page, { role: "production", gates: scheduled, now: ENDED_NOW });
      await page.route("**/api/v1/production", (route) =>
        route.fulfill({
          json: {
            ...runway,
            jobs: [
              {
                ...runwayJob,
                assignment: {
                  id: "assignment_synthetic",
                  type: "Production",
                  status: "Scheduled",
                  assignment_version: 1,
                  roof_job_version: 3,
                  crew_id: crews[0]!.id,
                  crew_version: 4,
                  scheduled_start: "2026-11-03T13:00:00.000Z",
                  scheduled_end: null,
                },
              },
            ],
          },
        }),
      );
      await page.goto(gatesUrl("crew"));
      await expect(page.getByText(/^Cleared Today 10:05/)).toBeVisible();
      await capture("07b-crew-cleared", "1322:5185", "7b · Crew · cleared at scheduling");
    }
    // 8a · Ask to waive Materials.
    await visit(
      endedBlocked({ Safety: ready.gates[2], Access: ready.gates[3] }),
      "waive-materials",
      "production",
      ENDED_NOW,
    );
    await page
      .getByLabel("Why waive Materials?")
      .fill("The shingles are at our yard. The supplier sends the reference this afternoon.");
    await capture("08a-waiver-ask", "1322:5205", "8a · Ask to waive Materials");
    // 8 · Waiting for the owner.
    await visit(
      endedBlocked({
        Safety: ready.gates[2],
        Access: ready.gates[3],
        Materials: gate("Materials", { version: 2, open_waiver_requests: [request()] }),
      }),
      "materials",
      "production",
      ENDED_NOW,
    );
    await capture("08-waiver-waiting", "1322:5229", "8 · Waiver asked, waiting for the owner");
    // 9 · Owner decides.
    await visit(
      endedBlocked({
        Safety: ready.gates[2],
        Access: ready.gates[3],
        Materials: gate("Materials", {
          version: 2,
          open_waiver_requests: [request({ is_own_request: false })],
        }),
      }),
      "waive-materials",
      "owner",
      ENDED_NOW,
    );
    await page
      .getByLabel("Your reason (needed to approve or to decline)")
      .fill(
        "I checked the shingles at the yard this morning. The supplier sends the reference this afternoon.",
      );
    await capture("09-waiver-decide", "1322:5253", "9 · Owner decides the waiver");
    // 10 and 10b · The only owner approves their own item.
    {
      const state = await visit(model("open"), "waive-access", "owner", OPEN_NOW, () => {
        state.gates = model("open", { Access: waived("Access") });
        return {
          status: 200,
          json: {
            gate: { name: "gate:access", gate: "Access", roof_job: JOB_ID, state: "Waived" },
            basis: "office_waiver",
            clearance: "waived",
            evidence_item: null,
            actor_role: "owner",
            replayed: false,
          },
        };
      });
      await page
        .getByLabel("Why are you approving this?")
        .fill(
          "Elena is away on the crew days. The crew works from the driveway and doesn’t need the house.",
        );
      await capture("10-waiver-own", "1322:5277", "10 · Approve your own item, only holder");
      await page.getByRole("button", { name: "Approve the Access waiver with reason" }).click();
      await expect(page.getByText(/^Approved own item/)).toBeVisible();
      await capture("10b-waiver-own-receipt", "1322:5301", "10b · Approved own item, receipt");
    }
    // 11 · The permit is unknown.
    await visit(
      model("open"),
      "safety",
      "production",
      OPEN_NOW,
      refuse("production_gate_safety_permit_unknown"),
    );
    await fillSafety("Permit unknown");
    await page.getByRole("button", { name: "Clear Safety with this proof" }).click();
    await expect(
      page.getByText("The permit is unknown, so you can’t clear Safety yet."),
    ).toBeVisible();
    await capture("11-safety-permit-unknown", "1322:5323", "11 · Refused: the permit is unknown");
    // 12 · Can't be waived.
    await visit(
      endedBlocked({ Materials: waived("Materials"), Access: waived("Access") }),
      undefined,
      "production",
      ENDED_NOW,
    );
    await capture("12-not-waivable", "1322:5357", "12 · Can’t be waived: Safety, Weather, Crew");
    // 13a and 13 · Reversal.
    {
      const cleared = clearedGate("Materials", materialsProof, "Prairie Coil Supply");
      const base = { Safety: ready.gates[2], Access: ready.gates[3] };
      const state = await visit(
        endedBlocked({ ...base, Materials: cleared }),
        "materials",
        "production",
        ENDED_NOW,
        (_path, body) => {
          const reversal = entry({
            from_gate_version: 2,
            kind: "reverse",
            basis: "person_reversal",
            to_state: "blocked",
            reason: (body as { reason: string }).reason,
            created_at: "2026-11-02T15:05:00.000Z",
          });
          state.gates = endedBlocked({
            ...base,
            Materials: gate("Materials", { version: 3, entries: [cleared.entries[0]!, reversal] }),
          });
          return {
            status: 200,
            json: {
              entry: reversal,
              gate: {
                name: "gate:materials",
                gate: "Materials",
                roof_job: JOB_ID,
                state: "blocked",
                version: 3,
              },
              replayed: false,
            },
          };
        },
      );
      await page
        .getByLabel("Why reverse it?")
        .fill("Order 3140 is another job’s. Elena’s order is 3152.");
      await capture("13a-reverse", "1322:5394", "13a · Reverse a wrong clearance");
      await page.getByRole("button", { name: "Reverse the clearance with this reason" }).click();
      await expect(page.getByText(/^Reversed today at 09:05/)).toBeVisible();
      await capture("13-reversed", "1322:5421", "13 · Clearance reversed, history kept");
    }
    // 14, 15, 16 · Safety refusals.
    for (const [code, file, frame, title] of [
      [
        "production_gate_attester_on_crew",
        "14-safety-on-crew",
        "1322:5450",
        "14 · Refused: on the crew for this job",
      ],
      [
        "production_gate_competency_required",
        "15-safety-competency",
        "1322:5484",
        "15 · Refused: no current competency record",
      ],
      [
        "production_gate_safety_stop_active",
        "16-safety-stop",
        "1322:5518",
        "16 · Refused: an active safety stop",
      ],
    ] as const) {
      await visit(model("open"), "safety", "production", OPEN_NOW, refuse(code));
      await fillSafety("Permit needed and held");
      await page.getByRole("button", { name: "Clear Safety with this proof" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await capture(file, frame, title);
    }
    // 17 · Open material problem.
    await visit(
      endedBlocked({ Safety: ready.gates[2], Access: ready.gates[3] }),
      "materials",
      "owner",
      ENDED_NOW,
      refuse("production_gate_material_exception_open"),
    );
    await page.getByLabel("Supplier", { exact: true }).fill("Prairie Coil Supply");
    await page.getByLabel("Supplier reference").fill("3152");
    await page.getByRole("button", { name: "Clear Materials with this proof" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await capture("17-materials-problem", "1322:5547", "17 · Refused: an open material problem");
    // 18 · Forecast too old.
    await visit(
      endedBlocked({ Materials: ready.gates[1], Safety: ready.gates[2], Access: ready.gates[3] }),
      "weather",
      "production",
      ENDED_NOW,
      refuse("production_gate_forecast_stale"),
    );
    await page.getByLabel("Work window starts").fill("2026-11-03T07:00");
    await page.getByLabel("Work window ends").fill("2026-11-04T17:00");
    await page.getByLabel("Forecast", { exact: true }).fill("Dry, wind under 30 km/h");
    await page.getByLabel("When you read it").fill("2026-10-29T06:00");
    await page.getByLabel("Where you read it").fill("weather.gc.ca");
    await page.getByRole("button", { name: "Clear Weather with this proof" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await capture("18-weather-stale", "1322:5581", "18 · Refused: forecast too old");
    // 19 · Window unknown.
    await visit(model("unknown"), undefined, "owner", OPEN_NOW);
    await capture("19-window-unknown", "1383:33772", "19 · Cancellation window · unknown");
    // 20 and 20b · Record the signed-copy time.
    {
      const state = await visit(model("unknown"), "window", "owner", OPEN_NOW, () => {
        state.gates = model("open");
        return {
          status: 201,
          json: {
            cancellation_window: windowState("open"),
            recorded: true,
            receipt_id: "pcw_synthetic",
            replayed: false,
          },
        };
      });
      await fillRecord("2026-10-20T18:26");
      await capture("20-record", "1446:1742", "20 · Add when the signed copy was received");
      await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();
      await expect(page.getByText(/^Recorded\./)).toBeVisible();
      await capture("20b-recorded", "1446:1779", "20b · Signed-copy time recorded");
    }
    // 20c · No reason or evidence.
    await visit(model("unknown"), "window", "owner", OPEN_NOW);
    await page.getByLabel("Signed copy received").fill("2026-10-20T18:26");
    await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();
    await capture("20c-record-missing", "1478:1063", "20c · Refused: no reason or evidence");
    // 21 · Before the contract.
    await visit(
      model("unknown"),
      "window",
      "owner",
      OPEN_NOW,
      refuse("cancellation_window_receipt_before_contract", {
        received_at: "2026-10-21T00:10:00.000Z",
        contract_signed_at: CONTRACT_SIGNED_AT,
        time_zone: "America/Edmonton",
      }),
    );
    await fillRecord("2026-10-20T18:10");
    await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await capture(
      "21-record-before-contract",
      "1446:1807",
      "21 · Refused: before the contract was signed",
    );
    // 22 · In the future.
    await visit(
      model("unknown"),
      "window",
      "owner",
      OPEN_NOW,
      refuse("cancellation_window_receipt_in_future", {
        received_at: "2026-10-22T00:26:00.000Z",
        now: OPEN_NOW.toISOString(),
        time_zone: "America/Edmonton",
      }),
    );
    await fillRecord("2026-10-21T18:26");
    await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await capture("22-record-future", "1446:1840", "22 · Refused: in the future");
    // 23 · Earlier than the time on record (ops; never production).
    await visit(
      model("open"),
      "window",
      "ops",
      new Date("2026-10-22T16:45:00.000Z"),
      refuse("cancellation_window_receipt_earlier_than_recorded", {
        received_at: "2026-10-21T00:21:00.000Z",
        recorded_received_at: "2026-10-21T00:26:00.000Z",
        recorded_source: "manual_record",
        window_ends_at: "2026-10-31T07:00:00.000Z",
        time_zone: "America/Edmonton",
      }),
    );
    await fillRecord("2026-10-20T18:21", "New time");
    await page.getByRole("button", { name: "Record when Elena Marchetti received it" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await capture("23-record-earlier", "1446:1873", "23 · Refused: would start the window earlier");
    // Q1 · Jobs missing a signed-copy time.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await office(page, { role: "ops", gates: model("unknown"), now: OPEN_NOW });
    await page.goto("/production/signed-copy-missing");
    await expect(page.getByText("Jobs with no signed-copy time: 3")).toBeVisible();
    await capture("q1-signed-copy-missing", "1446:1900", "Q1 · Jobs missing a signed-copy time");
    // N1 and N1b · the owner's items.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await office(page, {
      role: "owner",
      gates: model("open"),
      now: new Date("2026-11-02T23:30:00.000Z"),
    });
    await page.route("**/api/v1/owner/measurement-intake-exceptions", (route) =>
      route.fulfill({ json: { measurements: [] } }),
    );
    const stopItem = (kind: string, title: string, id: string) => ({
      id,
      kind,
      severity: null,
      title,
      why: "Safety and scheduling stay held on every job while this work stop is active.",
      next_action: null,
      job_id: null,
      occurred_at: "2026-11-02T22:05:00.000Z",
      due_at: null,
      received_at: null,
      bus_status: null,
      triage_status: null,
      mctb: null,
      reported_by_name: "Sam Keewatin",
      summary: "Soft deck boards by the back stairs. Crew is off the roof.",
    });
    await page.route("**/api/v1/owner/now", (route) =>
      route.fulfill({
        json: {
          version: 1,
          source_updated_at: "2026-11-02T23:30:00.000Z",
          read_model_generated_at: "2026-11-02T23:30:01.000Z",
          stale_fields: [],
          permissions: ["owner.now.read"],
          allowed_actions: [],
          partial_sources: [],
          exceptions: [
            stopItem(
              "stop_job_unknown",
              "This work stop names a job that doesn’t exist",
              "occ_job_synthetic",
            ),
            stopItem(
              "stop_work_package_unknown",
              "This work stop names a job plan that doesn’t exist",
              "occ_plan_synthetic",
            ),
          ],
          summary: {
            active_jobs: 3,
            field_blockers: 0,
            blocked_gates: 0,
            open_incidents: 0,
            finance_exceptions: 0,
            untriaged_leads: 0,
            lead_triage_unknown: 0,
            mctb_unproven_due: 0,
            material_exceptions: 0,
          },
        },
      }),
    );
    await page.goto("/owner");
    await expect(page.getByText("This work stop names a job that doesn’t exist")).toBeVisible();
    await expectAccessible(page);
    await capture(
      "n1-n1b-owner-stops",
      "1527:582 + 1597:737",
      "N1 and N1b · Needs the owner: a stop names a job or job plan that doesn’t exist",
    );

    await writeFile(`${shotsDir}/screens.json`, `${JSON.stringify(index, null, 2)}\n`);
  });
});
