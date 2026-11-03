import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppRole } from "../../lib/roles";
import type { JobGatesResponse } from "./gate-contracts";
import type { GateStep } from "./gate-model";
import {
  ENDED_NOW,
  JOB_ID,
  accessProof,
  clearedGate,
  entry,
  gate,
  materialsProof,
  model,
  readyToSchedule,
  request,
  runwayJob,
  screen as gateScreen,
  windowState,
} from "./gate-test-fixtures";
import { GatesScreen } from "./job-gates-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
    search?: { step?: string };
  }) => (
    <a
      href={`${to.replace("$jobId", params?.jobId ?? "$jobId")}${search?.step ? `?step=${search.step}` : ""}`}
      {...props}
    >
      {children}
    </a>
  ),
}));

interface Call {
  path: string;
  method: string;
  body: unknown;
  headers: Headers;
}

function stubFetch(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const call: Call = {
        path,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const { status, body } = answer(call);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(
  gates: JobGatesResponse,
  step?: GateStep,
  options: { role?: AppRole; now?: Date; refresh?: () => Promise<void> } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refresh = options.refresh ?? vi.fn(async () => undefined);
  const view = render(
    <QueryClientProvider client={client}>
      <GatesScreen screen={gateScreen(gates, { ...options, refresh })} step={step} />
    </QueryClientProvider>,
  );
  return { ...view, refresh };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const link = (name: string | RegExp) => screen.getByRole("link", { name });

describe("the gate overview", () => {
  it("frame 1: the window and Deposit are System states, Safety and Access clear now", () => {
    show(model("open"));
    expect(screen.getByRole("heading", { name: "Gates" })).toBeVisible();
    expect(screen.getByText("0 of 5 gates cleared · 4 blocked · 1 waiting")).toBeVisible();
    expect(screen.getByText("Cancellation window · not a gate")).toBeVisible();
    expect(
      screen.getByText(
        "Signed copy received Tue 20 Oct 18:26. Open until the end of Fri 30 Oct. Plan now; ordering, purchase orders and a firm start wait until then.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Deposit · not a gate")).toBeVisible();
    expect(screen.getByText("No deposit under this contract")).toBeVisible();
    expect(screen.getByText("Blocked: ordering waits for the window to end")).toBeVisible();
    expect(screen.getByText("Blocked: no hazard assessment yet")).toBeVisible();
    expect(screen.getByText("Blocked: nobody has confirmed site access yet")).toBeVisible();
    expect(screen.getByText("Blocked: no forecast yet; read it near the crew day")).toBeVisible();
    expect(screen.getByText("Waiting: clears when you schedule the crew")).toBeVisible();
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
    expect(link("Clear Safety")).toHaveAttribute(
      "href",
      `/production/jobs/${JOB_ID}/gates?step=safety`,
    );
    expect(link("Clear Safety").dataset.variant).toBe("primary");
    expect(link("Clear Access").dataset.variant).toBe("secondary");
    expect(screen.queryByRole("link", { name: "Clear Materials" })).not.toBeInTheDocument();
    expect(button("Schedule the crew · after the window ends")).toBeDisabled();
    expect(
      screen.getByText(
        "“Schedule the crew” turns on once the window ends and the 4 blocked gates clear.",
      ),
    ).toBeVisible();
  });

  it("frame 12: once the window ends, Safety and Weather say what clears them and can't be waived", () => {
    show(
      model("ended", {
        Materials: gate("Materials", {
          state: "waived",
          version: 2,
          entries: [
            entry({
              from_gate_version: 1,
              kind: "waiver_decision",
              basis: "office_waiver",
              to_state: "waived",
              actor_role: "owner",
            }),
          ],
        }),
        Access: gate("Access", {
          state: "waived",
          version: 2,
          entries: [
            entry({
              from_gate_version: 1,
              kind: "waiver_decision",
              basis: "office_waiver",
              to_state: "waived",
              actor_role: "owner",
            }),
          ],
        }),
      }),
    );
    expect(
      screen.getByText(
        "Safety, Weather and Crew can’t be waived: they keep the crew safe, so only proof clears them.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Blocked: clears with a work window of 14 days or less and a forecast from the last 72 hours",
      ),
    ).toBeVisible();
    expect(screen.getByText("Waiting: clears by itself when you schedule the crew")).toBeVisible();
    expect(screen.getAllByText("Waived Today 08:40")).toHaveLength(2);
    expect(link("Clear Safety").dataset.variant).toBe("primary");
    expect(link("Clear Weather").dataset.variant).toBe("secondary");
    expect(button("Schedule the crew · after Safety and Weather clear")).toBeDisabled();
    expect(
      screen.getByText("“Schedule the crew” turns on when Safety and Weather clear."),
    ).toBeVisible();
  });

  it("frame 19: an unknown window offers the owner or ops the one fix, and never production", () => {
    const { unmount } = show(model("unknown"), undefined, { role: "owner" });
    expect(
      screen.getByText(
        "No one has recorded when Elena Marchetti received the signed copy of the contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      ),
    ).toBeVisible();
    expect(link("Add when Elena Marchetti received the signed copy")).toHaveAttribute(
      "href",
      `/production/jobs/${JOB_ID}/gates?step=window`,
    );
    expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
    expect(button("Schedule the crew · after the window ends")).toBeDisabled();
    expect(screen.getByText("Adding that time shows when the window ends.")).toBeVisible();
    unmount();

    show(model("unknown"), undefined, { role: "production" });
    expect(
      screen.queryByRole("link", { name: /Add when Elena Marchetti received/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Only the Owner or Operations can add when Elena Marchetti received the signed copy.",
      ),
    ).toBeVisible();
    expect(link("Clear Safety")).toBeVisible();
  });

  it.each([
    [
      "signed_copy_unconfirmed",
      "Elena Marchetti was shown the signed copy at signing, but it was never confirmed sent, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      "Unknown: signed copy never confirmed sent",
    ],
    [
      "signed_copy_before_contract",
      "The signed-copy time on record is from before Elena Marchetti’s latest contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      "Unknown: signed-copy time is from an earlier contract",
    ],
    [
      "signed_copy_time_missing",
      "No one has recorded when Elena Marchetti received the signed copy of the contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      "Unknown: no signed-copy time",
    ],
  ] as const)("names why the window is unknown: %s", (reason, banner, row) => {
    show(model("unknown", {}, { unknown_reason: reason }), undefined, { role: "ops" });
    expect(screen.getByText(banner)).toBeVisible();
    expect(screen.getByText(row)).toBeVisible();
  });

  it("an ended window with every gate clear but Crew turns Schedule the crew on", () => {
    show(readyToSchedule());
    expect(
      screen.getByText("Signed copy received Tue 20 Oct 18:26. Ended at the end of Fri 30 Oct."),
    ).toBeVisible();
    expect(link("Schedule the crew")).toHaveAttribute(
      "href",
      `/production/jobs/${JOB_ID}/gates?step=crew`,
    );
    expect(screen.getByText("4 of 5 gates cleared · 1 waiting")).toBeVisible();
  });

  it("shows the exact end only when the hold does not end with the last day", () => {
    show(model("open", {}, { ends_on_calendar_day: false, ends_at: "2026-11-01T08:00:00.000Z" }));
    expect(
      screen.getByText(
        "Signed copy received Tue 20 Oct 18:26. Open until Sun 1 Nov 02:00. Plan now; ordering, purchase orders and a firm start wait until then.",
      ),
    ).toBeVisible();
  });
});

describe("Materials", () => {
  it("frame 2: held by the window, with the held clear and the way back", () => {
    show(model("open"), "materials");
    expect(
      screen.getByText(
        "Signed copy received Tue 20 Oct 18:26. Cancellation window · open until the end of Fri 30 Oct",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Materials blocked · Safety blocked · Access blocked · Weather blocked · Crew waiting",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Elena Marchetti can still cancel until the window ends, so nothing is ordered before then.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Signed copy received Tue 20 Oct 18:26. Open until the end of Fri 30 Oct. It holds ordering, a firm start and any purchase order moving to ordered or sent. It can’t be waived.",
      ),
    ).toBeVisible();
    expect(button("Clear Materials with this proof · after the window ends")).toBeDisabled();
    expect(link("Back to the gate list").dataset.variant).toBe("primary");
  });

  it("frame 3: clears with the supplier's reference and sends the typed proof", async () => {
    const refresh = vi.fn(async () => undefined);
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        entry: entry({ from_gate_version: 1, attestation: materialsProof }),
        gate: {
          name: "gate:materials",
          gate: "Materials",
          roof_job: JOB_ID,
          state: "ready",
          version: 2,
        },
        replayed: false,
      },
    }));
    show(model("ended"), "materials", { refresh });
    expect(button("Clear Materials with this proof")).toBeDisabled();
    expect(link("Ask to waive Materials")).toHaveAttribute(
      "href",
      `/production/jobs/${JOB_ID}/gates?step=waive-materials`,
    );
    expect(
      button("Schedule the crew · after Materials, Safety, Access and Weather clear"),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Once Materials, Safety, Access and Weather are cleared, “Schedule the crew” turns on.",
      ),
    ).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Supplier"), "Prairie Coil Supply");
    await user.type(screen.getByLabelText("Supplier reference"), "3152");
    await user.click(button("Clear Materials with this proof"));
    expect(calls[0]?.path).toBe(`/api/v1/production/jobs/${JOB_ID}/gates/Materials/clearance`);
    expect(calls[0]?.body).toEqual({
      basis: "person_attestation",
      expected_gate_version: 1,
      attestation: { source: "supplier_delivery", reference: "3152", notes: "Prairie Coil Supply" },
    });
    expect(calls[0]?.headers.get("idempotency-key")).toMatch(/^production-gate-attestation:/);
    expect(refresh).toHaveBeenCalled();
  });

  it("frame 17: an open material problem holds Materials, with the way to it", async () => {
    stubFetch(() => ({ status: 409, body: { error: "production_gate_material_exception_open" } }));
    show(model("ended"), "materials", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Supplier reference"), "3152");
    await user.click(button("Clear Materials with this proof"));
    expect(
      await screen.findByText(
        "This job has an open material problem, so Materials can’t clear yet.",
      ),
    ).toBeVisible();
    expect(link("See the material problem")).toHaveAttribute("href", "/inventory");
    expect(button("Clear Materials with this proof · after the problem is closed")).toBeDisabled();
    expect(
      screen.getByText("“Clear Materials with this proof” turns on once the problem is closed."),
    ).toBeVisible();
  });

  it("frame 13a: reverses a wrong clearance with a reason, nothing deleted", async () => {
    const cleared = clearedGate("Materials", materialsProof, "Prairie Coil Supply");
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        entry: entry({
          from_gate_version: 2,
          kind: "reverse",
          basis: "person_reversal",
          to_state: "blocked",
        }),
        gate: {
          name: "gate:materials",
          gate: "Materials",
          roof_job: JOB_ID,
          state: "blocked",
          version: 3,
        },
        replayed: false,
      },
    }));
    show(model("ended", { Materials: cleared }), "materials");
    expect(screen.getByText("Cleared Today 08:40 by production")).toBeVisible();
    expect(screen.getByText("Prairie Coil Supply · 3140")).toBeVisible();
    expect(button("Clear Materials with the right proof · after you reverse this")).toBeDisabled();
    const reverse = button("Reverse the clearance with this reason");
    expect(reverse).toBeDisabled();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Why reverse it?"),
      "Order 3140 is another job’s. Elena’s order is 3152.",
    );
    await user.click(reverse);
    expect(calls[0]?.path).toBe(`/api/v1/production/jobs/${JOB_ID}/gates/Materials/reversals`);
    expect(calls[0]?.body).toEqual({
      expected_gate_version: 2,
      reverses_id: cleared.entries[0]!.id,
      reason: "Order 3140 is another job’s. Elena’s order is 3152.",
    });
  });

  it("frame 13: a reversed clearance keeps its history and offers the right proof", async () => {
    const first = entry({
      from_gate_version: 1,
      attestation: materialsProof,
      reason: "Prairie Coil Supply",
      created_at: "2026-11-02T14:40:00.000Z",
    });
    const reversal = entry({
      from_gate_version: 2,
      kind: "reverse",
      basis: "person_reversal",
      to_state: "blocked",
      reason: "order 3140 is another job’s. Elena’s order is 3152.",
      created_at: "2026-11-02T15:05:00.000Z",
    });
    show(
      model("ended", { Materials: gate("Materials", { version: 3, entries: [first, reversal] }) }),
      "materials",
    );
    expect(
      screen.getByText("Reversed today at 09:05. Materials is blocked again. Nothing was deleted."),
    ).toBeVisible();
    expect(screen.getByText("Today 09:05 · Reversed")).toBeVisible();
    expect(
      screen.getByText("Production: order 3140 is another job’s. Elena’s order is 3152."),
    ).toBeVisible();
    expect(screen.getByText("Today 08:40 · Cleared")).toBeVisible();
    expect(screen.getByText("Production: Prairie Coil Supply · 3140")).toBeVisible();
    expect(
      screen.getByText(
        "“Schedule the crew” stays off until Materials, Safety, Access and Weather clear.",
      ),
    ).toBeVisible();
    await userEvent.setup().click(button("Clear Materials with the right proof"));
    expect(screen.getByLabelText("Supplier reference")).toBeVisible();
  });
});

async function fillSafety(user: ReturnType<typeof userEvent.setup>, permit: RegExp) {
  await user.type(screen.getByLabelText("Hazard assessment"), "4417");
  await user.type(screen.getByLabelText("When it was done"), "2026-10-21T10:40");
  await user.click(screen.getByRole("radio", { name: permit }));
  if (permit.source.includes("held")) {
    await user.type(screen.getByLabelText("Permit number"), "building permit 4417");
  }
  await user.click(screen.getByRole("radio", { name: "Fall-protection plan" }));
  await user.type(screen.getByRole("textbox", { name: "Fall-protection plan" }), "ridge-anchors-2");
}

describe("Safety", () => {
  it("frame 4: the permit answer and fall protection, sent as Safety's typed proof", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        entry: entry({ from_gate_version: 1 }),
        gate: { name: "gate:safety", gate: "Safety", roof_job: JOB_ID, state: "ready", version: 2 },
        replayed: false,
      },
    }));
    show(model("open"), "safety");
    expect(
      screen.getByText(
        "Only someone who holds “checks site safety” and isn’t on this crew can clear Safety. It can’t be waived.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /waive/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "“Schedule the crew” turns on once the window ends and every gate is clear.",
      ),
    ).toBeVisible();
    const user = userEvent.setup();
    await fillSafety(user, /needed and held/);
    await user.click(button("Clear Safety with this proof"));
    expect(calls[0]?.body).toEqual({
      basis: "person_attestation",
      expected_gate_version: 1,
      attestation: {
        hazard_assessment_ref: "4417",
        permit: { answer: "needed_and_held", number: "building permit 4417" },
        fall_protection: { plan_ref: "ridge-anchors-2" },
        assessed_at: "2026-10-21T16:40:00.000Z",
      },
    });
  });

  it("frame 11: an unknown permit is refused by name, and the fix is to change the answer", async () => {
    stubFetch(() => ({ status: 409, body: { error: "production_gate_safety_permit_unknown" } }));
    show(model("open"), "safety");
    const user = userEvent.setup();
    await fillSafety(user, /unknown/);
    await user.click(button("Clear Safety with this proof"));
    expect(
      await screen.findByText("The permit is unknown, so you can’t clear Safety yet."),
    ).toBeVisible();
    expect(
      screen.getByText("Unknown: nobody has checked whether this job needs one"),
    ).toBeVisible();
    expect(
      button("Clear Safety with this proof · after you change the permit answer"),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "To clear Safety, choose “Permit needed and held” with its number, or “Permit not needed”.",
      ),
    ).toBeVisible();
    await user.click(button("Change the permit answer"));
    expect(screen.getByRole("radio", { name: "Permit unknown" })).not.toBeChecked();
    expect(screen.getByLabelText("Hazard assessment")).toHaveValue("4417");
  });

  it.each([
    [
      "production_gate_attester_on_crew",
      "You’re on the crew for this job, so you can’t clear its Safety.",
      "Clear Safety with this proof · after someone off this crew clears it",
    ],
    [
      "production_gate_competency_required",
      "You have no current competency record, so you can’t clear Safety yet.",
      "Clear Safety with this proof · after your record is current",
    ],
    [
      "production_gate_safety_stop_active",
      "This job has an active safety stop, so Safety can’t clear until it’s lifted.",
      "Clear Safety with this proof · after the stop is lifted",
    ],
    [
      "production_gate_stop_job_unknown",
      "A work stop names a job that doesn’t exist, so Safety stays held on every job until it’s lifted.",
      "Clear Safety with this proof · after the stop is lifted",
    ],
    [
      "production_gate_stop_work_package_unknown",
      "A work stop names a job plan that doesn’t exist, so Safety stays held on every job until it’s lifted.",
      "Clear Safety with this proof · after the stop is lifted",
    ],
  ])("frames 14-16: %s", async (code, title, heldLabel) => {
    stubFetch(() => ({
      status: code.includes("competency") || code.includes("crew") ? 403 : 409,
      body: { error: code },
    }));
    show(model("open"), "safety", { role: "owner" });
    const user = userEvent.setup();
    await fillSafety(user, /needed and held/);
    await user.click(button("Clear Safety with this proof"));
    expect(await screen.findByText(title)).toBeVisible();
    expect(button(heldLabel)).toBeDisabled();
  });

  it("frames 15 and 16 point the owner at the record or the stop, and production back to the list", async () => {
    stubFetch(() => ({ status: 409, body: { error: "production_gate_safety_stop_active" } }));
    const owner = show(model("open"), "safety", { role: "owner" });
    const user = userEvent.setup();
    await fillSafety(user, /needed and held/);
    await user.click(button("Clear Safety with this proof"));
    expect(await screen.findByRole("link", { name: "See the safety stop" })).toHaveAttribute(
      "href",
      "/safety",
    );
    owner.unmount();

    stubFetch(() => ({ status: 403, body: { error: "production_gate_competency_required" } }));
    show(model("open"), "safety", { role: "production" });
    await fillSafety(user, /needed and held/);
    await user.click(button("Clear Safety with this proof"));
    expect(
      await screen.findByText("Ask the office to add your current competency record."),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Add your current competency record" }),
    ).not.toBeInTheDocument();
    expect(link("Back to the gate list")).toBeVisible();
  });
});

describe("Access and Weather", () => {
  it("frame 5: who confirmed access, when, and what they confirmed", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        entry: entry({ from_gate_version: 1 }),
        gate: { name: "gate:access", gate: "Access", roof_job: JOB_ID, state: "ready", version: 2 },
        replayed: false,
      },
    }));
    show(model("open", { Safety: clearedGate("Safety", {}, null) }), "access");
    expect(
      screen.getByText(
        "“Schedule the crew” turns on once the window ends and Materials, Access and Weather are cleared.",
      ),
    ).toBeVisible();
    expect(link("Ask to waive Access")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "The customer" }));
    await user.type(screen.getByLabelText("When"), "2026-10-21T10:30");
    await user.type(
      screen.getByLabelText("What they confirmed"),
      "Side gate unlocked on the crew days; driveway clear for the bin",
    );
    await user.click(button("Clear Access with this proof"));
    expect(calls[0]?.body).toEqual({
      basis: "person_attestation",
      expected_gate_version: 1,
      attestation: {
        confirmed_with: "customer",
        confirmed_at: "2026-10-21T16:30:00.000Z",
        notes: "Side gate unlocked on the crew days; driveway clear for the bin",
      },
    });
  });

  it("frames 6 and 18: a work window and a forecast; a forecast over 72 hours old is refused", async () => {
    stubFetch(() => ({ status: 409, body: { error: "production_gate_forecast_stale" } }));
    const ready = readyToSchedule();
    show(
      model("ended", { Materials: ready.gates[1], Safety: ready.gates[2], Access: ready.gates[3] }),
      "weather",
    );
    expect(
      screen.getByText(
        "Weather can’t be waived. It needs a work window of 14 days or less and a forecast from the last 72 hours.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Clearing Weather turns on “Schedule the crew”.")).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Work window starts"), "2026-11-03T07:00");
    await user.type(screen.getByLabelText("Work window ends"), "2026-11-04T17:00");
    expect(screen.getByText("Tue 3 Nov 07:00 to Wed 4 Nov 17:00 · 2 days")).toBeVisible();
    await user.type(screen.getByLabelText("Forecast"), "Dry, wind under 30 km/h");
    await user.type(screen.getByLabelText("When you read it"), "2026-10-29T06:00");
    await user.type(screen.getByLabelText("Where you read it"), "weather.gc.ca");
    await user.click(button("Clear Weather with this proof"));
    expect(
      await screen.findByText(
        "This forecast is from Thu 29 Oct, over 72 hours ago, so Weather can’t clear.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Dry, wind under 30 km/h · Thu 29 Oct 06:00")).toBeVisible();
    expect(button("Clear Weather with this proof · after you add a newer forecast")).toBeDisabled();
    await user.click(button("Add a forecast from the last 72 hours"));
    expect(screen.getByLabelText("When you read it")).toHaveValue("");
  });
});

describe("Crew", () => {
  it("frame 7: Crew clears by scheduling, held for the window", () => {
    show(model("open"), "crew");
    expect(
      screen.getByText(
        "Crew clears by itself when you schedule the crew. There’s no form, and it can’t be waived.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Not yet: no crew scheduled for this job")).toBeVisible();
    expect(button("Schedule the crew · after the window ends")).toBeDisabled();
    // Issuing the job plan isn't gated: the gates hold the firm start, never the plan.
    expect(screen.queryByRole("button", { name: /Issue/ })).not.toBeInTheDocument();
  });

  it("schedules the crew once every gate is clear and the window has ended", async () => {
    const calls = stubFetch(() => ({
      status: 409,
      body: { error: "operating_job_assignment_outside_weather_window" },
    }));
    show(readyToSchedule(), "crew");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Which crew"), "Sam Keewatin’s crew");
    await user.type(screen.getByLabelText("Crew day starts"), "2026-11-03T07:00");
    await user.click(button("Schedule the crew"));
    expect(calls[0]?.path).toBe(`/api/v1/jobs/${JOB_ID}/schedule`);
    expect(calls[0]?.body).toMatchObject({
      expected_roof_job_version: runwayJob.version,
      crew_id: "crew_sam_keewatin_synthetic",
      expected_crew_version: 4,
      scheduled_start: "2026-11-03T07:00:00-06:00",
      scheduled_end: null,
    });
    expect(
      await screen.findByText(
        "The crew day falls outside the Weather work window. Pick a time inside it.",
      ),
    ).toBeVisible();
  });

  it("frame 7b: cleared at scheduling, and the job plan is next", () => {
    const ready = readyToSchedule();
    const crew = gate("Crew", {
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
    const gates = {
      ...ready,
      gates: ready.gates.map((candidate) => (candidate.gate === "Crew" ? crew : candidate)),
    };
    const view = gateScreen(gates, { now: ENDED_NOW });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <GatesScreen
          screen={{
            ...view,
            runwayJob: {
              ...runwayJob,
              assignment: {
                id: "assignment_synthetic",
                type: "Production",
                status: "Scheduled",
                assignment_version: 1,
                roof_job_version: 3,
                crew_id: "crew_sam_keewatin_synthetic",
                crew_version: 4,
                scheduled_start: "2026-11-03T13:00:00.000Z",
                scheduled_end: null,
              },
            },
          }}
          step="crew"
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("All 5 gates are cleared and the cancellation window has ended."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Cleared Today 10:05: Sam Keewatin’s crew scheduled for Tue 3 Nov 07:00 (the cancellation window ended at the end of Fri 30 Oct)",
      ),
    ).toBeVisible();
    expect(link("Issue job plan")).toHaveAttribute("href", `/jobs/${JOB_ID}`);
  });
});

describe("waivers", () => {
  it("frame 8a: production asks the owner, and a recorded request is not a failure", async () => {
    const refresh = vi.fn(async () => undefined);
    const calls = stubFetch(() => ({
      status: 409,
      body: { error: "production_gate_waiver_requested" },
    }));
    show(model("ended"), "waive-materials", { refresh });
    expect(
      screen.getByText("An owner decides waivers. Materials stays blocked until they do."),
    ).toBeVisible();
    const ask = button("Ask the owner to waive Materials");
    expect(ask).toBeDisabled();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Why waive Materials?"),
      "The shingles are at our yard. The supplier sends the reference this afternoon.",
    );
    await user.click(ask);
    expect(calls[0]?.body).toEqual({
      basis: "office_waiver",
      reason: "The shingles are at our yard. The supplier sends the reference this afternoon.",
    });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("frame 8: the request is recorded and Materials waits on the owner", () => {
    show(
      model("ended", {
        Materials: gate("Materials", { version: 2, open_waiver_requests: [request()] }),
      }),
      "materials",
    );
    expect(
      screen.getByText(
        "Your request is recorded, today at 08:20. An owner decides; Materials stays blocked until then.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Materials waiting on the owner · Safety blocked · Access blocked · Weather blocked · Crew waiting",
      ),
    ).toBeVisible();
    expect(link("Back to the gate list").dataset.variant).toBe("primary");
    expect(link("Clear Materials with proof instead").dataset.variant).toBe("secondary");
  });

  it("frame 9: the owner approves or declines another person's request with a reason", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        decision: {
          clearance_id: `pgc_${"b".repeat(40)}`,
          request_id: request().request_id,
          decision: "decline",
          requested_by: "u1",
          decided_by: "u2",
          actor_role: "owner",
          self_approval: false,
          self_approval_basis: null,
          reason: "The supplier's reference comes first.",
          created_at: "2026-11-02T16:00:00.000Z",
        },
        gate: {
          name: "gate:materials",
          gate: "Materials",
          roof_job: JOB_ID,
          state: "blocked",
          version: 3,
        },
        replayed: false,
      },
    }));
    show(
      model("ended", {
        Materials: gate("Materials", {
          version: 2,
          open_waiver_requests: [request({ is_own_request: false })],
        }),
      }),
      "waive-materials",
      { role: "owner" },
    );
    expect(
      screen.getByText(
        "Production asks to waive Materials: “The shingles are at our yard. The supplier sends the reference this afternoon.”",
      ),
    ).toBeVisible();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Your reason (needed to approve or to decline)"),
      "The supplier's reference comes first.",
    );
    await user.click(button("Decline with this reason"));
    expect(calls[0]?.path).toBe(
      `/api/v1/production/jobs/${JOB_ID}/gates/Materials/waiver-decisions`,
    );
    expect(calls[0]?.body).toEqual({
      request_id: request().request_id,
      expected_gate_version: 2,
      decision: "decline",
      reason: "The supplier's reference comes first.",
    });
  });

  it("frames 10 and 10b: explains both owner outcomes and claims approval only after confirmation", async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        gate: { name: "gate:access", gate: "Access", roof_job: JOB_ID, state: "Waived" },
        basis: "office_waiver",
        clearance: "waived",
        evidence_item: null,
        actor_role: "owner",
        replayed: false,
      },
    }));
    show(model("open"), "waive-access", { role: "owner" });
    expect(
      screen.getByText(
        "If you’re the only person who can approve this waiver, submitting it approves it. Otherwise, another owner decides and the gate stays blocked.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Only you can approve this\./)).not.toBeInTheDocument();
    const user = userEvent.setup();
    const reason =
      "Elena is away on the crew days. The crew works from the driveway and doesn’t need the house.";
    await user.type(screen.getByLabelText("Why waive Access?"), reason);
    await user.click(button("Submit the Access waiver with reason"));
    expect(
      await screen.findByText(
        `You approved this waiver yourself, since only you can. Your reason: “${reason}”`,
      ),
    ).toBeVisible();
    // This write response confirms approval but carries no authoritative timestamp.
    expect(screen.getByText("Waived by you")).toBeVisible();
    expect(
      screen.getByText(
        "Safety can be cleared now. Materials and Weather wait for the window to end.",
      ),
    ).toBeVisible();
  });

  it("does not claim an owner's waiver was approved when the server records a request", async () => {
    const calls = stubFetch(() => ({
      status: 409,
      body: { error: "production_gate_waiver_requested" },
    }));
    const { refresh } = show(model("open"), "waive-access", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Why waive Access?"), "The crew uses the driveway.");
    await user.click(button("Submit the Access waiver with reason"));
    expect(calls[0]?.body).toEqual({
      basis: "office_waiver",
      reason: "The crew uses the driveway.",
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText(/You approved this waiver yourself/)).not.toBeInTheDocument();
    expect(screen.queryByText("Waived by you")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the owner's declined answer on the gate, and never offers a Safety waiver", () => {
    const decline = entry({
      from_gate_version: 2,
      kind: "waiver_decision",
      basis: "office_waiver",
      to_state: "blocked",
      actor_role: "owner",
      reason: "The supplier's reference comes first.",
      created_at: "2026-11-02T16:00:00.000Z",
    });
    const { unmount } = show(
      model("ended", { Materials: gate("Materials", { version: 3, entries: [decline] }) }),
      "waive-materials",
      { role: "ops" },
    );
    expect(
      screen.getByText("Declined Today 10:00: “The supplier's reference comes first.”"),
    ).toBeVisible();
    unmount();
    show(model("ended"), "waive-access", { role: "production" });
    expect(
      screen.getByText("An owner decides waivers. Access stays blocked until they do."),
    ).toBeVisible();
    expect(within(document.body).queryByText(/waive Safety/)).not.toBeInTheDocument();
  });
});

describe("the people-only record step", () => {
  it("never draws the record control for production", () => {
    show(model("unknown"), "window", { role: "production" });
    expect(screen.queryByRole("button", { name: /Record when/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Only the Owner or Operations can record when Elena Marchetti received the signed copy.",
      ),
    ).toBeVisible();
  });

  it("frame 20 → 20b: records when the customer received the signed copy", async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: {
        cancellation_window: windowState("open"),
        recorded: true,
        receipt_id: "pcw_synthetic",
        replayed: false,
      },
    }));
    show(model("unknown"), "window", { role: "owner" });
    expect(screen.getByText("Cancellation window · unknown: no signed-copy time")).toBeVisible();
    expect(screen.getByText("Contract signed Tue 20 Oct 18:20")).toBeVisible();
    expect(
      screen.getByText(
        "Only the Owner or Operations can record this, and you’re the Owner. The 10 days count from when Elena Marchetti received the signed copy, not from the signing. It can’t be in the future or before Tue 20 Oct 18:20.",
      ),
    ).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-20T18:26");
    await user.type(
      screen.getByLabelText("Why are you recording it?"),
      "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
    );
    await user.type(
      screen.getByLabelText("Evidence reference"),
      "Delivered email · signed copy.pdf",
    );
    await user.click(button("Record when Elena Marchetti received it"));
    expect(calls[0]?.path).toBe(
      `/api/v1/production/jobs/${JOB_ID}/cancellation-window/signed-copy`,
    );
    expect(calls[0]?.body).toEqual({
      received_at: "2026-10-20T18:26:00-06:00",
      reason:
        "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
      evidence_ref: "Delivered email · signed copy.pdf",
    });
    expect(
      await screen.findByText(
        "Recorded. The cancellation window is open until the end of Fri 30 Oct.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Tue 20 Oct 18:26 · recorded Today 08:40 by you")).toBeVisible();
    expect(screen.getByText("Delivered email · signed copy.pdf")).toBeVisible();
    expect(button("Schedule the crew · after the window ends")).toBeDisabled();
    expect(
      screen.getByText(
        "Plan now; ordering, purchase orders and a firm start wait until the end of Fri 30 Oct.",
      ),
    ).toBeVisible();
  });

  it("speaks to ops as ops", () => {
    show(model("unknown"), "window", { role: "ops" });
    expect(screen.getByText(/and you’re in Operations\./)).toBeVisible();
  });

  it("uses the returned window after a save, including a newer person's receipt and an exact end", async () => {
    const after = windowState("ended", {
      ends_on_calendar_day: false,
      ends_at: "2026-11-01T08:00:00.000Z",
    });
    after.signed_copy_received = {
      ...after.signed_copy_received!,
      id: "pcw_newer_record",
      received_at: "2026-10-21T00:27:00.000Z",
    };
    stubFetch(() => ({
      status: 201,
      body: {
        cancellation_window: after,
        recorded: true,
        receipt_id: "pcw_viewer_record",
        replayed: false,
      },
    }));
    show(model("unknown"), "window", { role: "owner", now: ENDED_NOW });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-20T18:26");
    await user.type(screen.getByLabelText("Why are you recording it?"), "The email was delivered.");
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      await screen.findByText("Recorded. The cancellation window ended Sun 1 Nov 02:00."),
    ).toBeVisible();
    expect(
      screen.getByText("Tue 20 Oct 18:27 · recorded Wed 21 Oct 08:40 by Dana Whitford · Owner"),
    ).toBeVisible();
    expect(screen.queryByText(/recorded .* by you/)).not.toBeInTheDocument();
    expect(
      button("Schedule the crew · after Materials, Safety, Access and Weather clear"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Schedule the crew · after the window ends" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "cancellation_window_receipt_reason_and_evidence_required",
      "Nothing was recorded: add why you’re recording this time and the evidence, so others can check where it came from.",
      "Add the reason and evidence",
      "Record when Elena Marchetti received it · after you add both",
    ],
    [
      "cancellation_window_receipt_reason_required",
      "Nothing was recorded: add why you’re recording this time, so others can check where it came from.",
      "Add the reason",
      "Record when Elena Marchetti received it · after you add it",
    ],
    [
      "cancellation_window_receipt_evidence_required",
      "Nothing was recorded: add the evidence, so others can check where this time came from.",
      "Add the evidence",
      "Record when Elena Marchetti received it · after you add it",
    ],
  ])("frame 20c from the Worker: %s", async (code, title, fix, heldLabel) => {
    stubFetch(() => ({ status: 400, body: { error: code } }));
    show(model("unknown"), "window", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-20T18:26");
    // Long enough locally; the Worker trims and judges again.
    await user.type(screen.getByLabelText("Why are you recording it?"), "Delivered by email.");
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(await screen.findByText(title)).toBeVisible();
    expect(button(heldLabel)).toBeDisabled();
    await user.click(button(fix));
    expect(button("Record when Elena Marchetti received it")).toBeEnabled();
  });

  it("frame 20c before sending: nothing is sent without the reason and the evidence", async () => {
    const calls = stubFetch(() => ({ status: 500, body: {} }));
    show(model("unknown"), "window", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-20T18:26");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      screen.getByText(
        "Nothing was recorded: add why you’re recording this time and the evidence, so others can check where it came from.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Type how you know when Elena Marchetti received it")).toBeVisible();
    expect(screen.getByText("Type an evidence reference")).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it("frame 21: before the contract was signed", async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        error: "cancellation_window_receipt_before_contract",
        received_at: "2026-10-21T00:10:00.000Z",
        contract_signed_at: "2026-10-21T00:20:00.000Z",
        time_zone: "America/Edmonton",
      },
    }));
    show(model("unknown"), "window", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-20T18:10");
    await user.type(
      screen.getByLabelText("Why are you recording it?"),
      "The email shows delivery.",
    );
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      await screen.findByText(
        "Tue 20 Oct 18:10 is before the contract was signed (Tue 20 Oct 18:20), so Elena Marchetti can’t have received the signed copy then. Check the delivered email.",
      ),
    ).toBeVisible();
    expect(button("Record when Elena Marchetti received it · after you change it")).toBeDisabled();
    expect(screen.getByText("Enter a time from Tue 20 Oct 18:20 up to now.")).toBeVisible();
    await user.click(button("Change the time"));
    expect(screen.getByLabelText("Signed copy received")).toHaveFocus();
  });

  it("frame 22: a time that hasn't happened yet", async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        error: "cancellation_window_receipt_in_future",
        received_at: "2026-10-22T00:26:00.000Z",
        now: "2026-10-21T16:45:00.000Z",
        time_zone: "America/Edmonton",
      },
    }));
    show(model("unknown"), "window", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signed copy received"), "2026-10-21T18:26");
    await user.type(
      screen.getByLabelText("Why are you recording it?"),
      "The email shows delivery.",
    );
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      await screen.findByText(
        "Today at 18:26 hasn’t happened yet, so Elena Marchetti can’t have received the signed copy then. Check the delivered email.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Today 18:26")).toBeVisible();
  });

  it("frame 23: a time earlier than the one on record is never saved", async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        error: "cancellation_window_receipt_earlier_than_recorded",
        received_at: "2026-10-21T00:21:00.000Z",
        recorded_received_at: "2026-10-21T00:26:00.000Z",
        recorded_source: "manual_record",
        window_ends_at: "2026-10-31T07:00:00.000Z",
        time_zone: "America/Edmonton",
      },
    }));
    show(model("open"), "window", { role: "owner", now: new Date("2026-10-22T16:45:00.000Z") });
    expect(screen.getByText("Signed copy received, on record")).toBeVisible();
    // The read carries a name and role, not an identity match. Another owner can share both.
    expect(
      screen.getByText("Tue 20 Oct 18:26 · recorded Wed 21 Oct 08:40 by Dana Whitford · Owner"),
    ).toBeVisible();
    expect(screen.queryByText(/recorded .* by you/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New time"), "2026-10-20T18:21");
    await user.type(
      screen.getByLabelText("Why are you recording it?"),
      "The email shows delivery.",
    );
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      await screen.findByText(
        "Tue 20 Oct 18:21 is earlier than the time on record. This time can only move later, never earlier, so this isn’t saved.",
      ),
    ).toBeVisible();
    expect(screen.getByText("The window is still open until the end of Fri 30 Oct.")).toBeVisible();
    await user.click(button("Keep Tue 20 Oct 18:26"));
    expect(screen.getByLabelText("New time")).toHaveValue("");
  });

  it("says so when the time is already on record", async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        cancellation_window: windowState("open"),
        recorded: false,
        unchanged: true,
        replayed: false,
      },
    }));
    show(model("open"), "window", { role: "owner" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New time"), "2026-10-20T18:26");
    await user.type(
      screen.getByLabelText("Why are you recording it?"),
      "The email shows delivery.",
    );
    await user.type(screen.getByLabelText("Evidence reference"), "Delivered email");
    await user.click(button("Record when Elena Marchetti received it"));
    expect(
      await screen.findByText("That time is already on record, so nothing changed."),
    ).toBeVisible();
  });
});

describe("reading without clearing", () => {
  it("shows ops a cleared gate and its history without a reversal", () => {
    show(
      model("ended", { Access: clearedGate("Access", accessProof, "Side gate unlocked") }),
      "access",
      {
        role: "ops",
      },
    );
    expect(screen.queryByRole("button", { name: /Reverse/ })).not.toBeInTheDocument();
    expect(screen.getByText("Production: The customer · Side gate unlocked")).toBeVisible();
  });
});
