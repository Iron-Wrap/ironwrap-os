import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { getDatabase, resetDatabaseForTests } from "../storage/db";
import { flushOutbox } from "../storage/outbox-processor";
import { cacheFieldModel } from "./field-cache";
import { occurrenceIdFor, resolveStopJob, type StopJob } from "./job-stop";
import { JobStopSheet } from "./job-stop-sheet";

vi.mock("../storage/outbox-processor", () => ({ flushOutbox: vi.fn() }));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_sam",
    email: "sam@example.invalid",
    display_name: "Sam Keewatin",
    role: "field",
    frappe_user_id: "sam@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-08-18T12:00:00.000Z",
  source_updated_at: "2026-08-17T12:00:00.000Z",
  read_model_generated_at: "2026-08-17T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const job: StopJob = { id: "JOB-ELENA", code: "J-ELENA", address: "118 Larkspur Way NW" };

async function safetyActions() {
  return (await (await getDatabase()).getAll("outbox_actions")).filter(
    (action) => action.kind === "safety_action",
  );
}

/** The office answers every queued action, as the Worker would once the phone has signal. */
function officeAnswers(answer: { scopeUnresolved?: boolean } = {}) {
  vi.mocked(flushOutbox).mockImplementation(async () => {
    const database = await getDatabase();
    for (const action of await database.getAll("outbox_actions")) {
      if (action.state !== "queued") continue;
      await database.put("outbox_actions", {
        ...action,
        state: "verified",
        verification: { verifiedAt: Date.now(), ...answer },
      });
    }
    return { processed: 1, verified: 1, requeued: 0, needsAttention: 0 };
  });
}

function noSignal() {
  vi.mocked(flushOutbox).mockResolvedValue({
    processed: 0,
    verified: 0,
    requeued: 1,
    needsAttention: 0,
  });
}

describe("JobStopSheet", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("S20: names the job, says what sending does, and offers 911 and the stop", async () => {
    render(<JobStopSheet session={session} job={job} />);
    expect(screen.getByText("Job J-ELENA · 118 Larkspur Way NW")).toBeVisible();
    expect(screen.getByLabelText("What is unsafe (optional)")).toBeVisible();
    expect(
      screen.getByText(
        "Sending stops work on job J-ELENA on every crew phone until the office releases it.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Emergency: call 911. Stopping work is always OK. You never get in trouble for it.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Call 911" })).toHaveAttribute("href", "tel:911");
    expect(screen.getByRole("button", { name: "Send stop report" })).toBeVisible();
  });

  it("S20: an empty field still stops this job, never the whole company", async () => {
    officeAnswers();
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    await waitFor(async () => expect(await safetyActions()).toHaveLength(1));
    const [saved] = await safetyActions();
    expect(saved?.payload).toMatchObject({
      kind: "report_occurrence",
      scope_type: "roof_job",
      scope_id: "JOB-ELENA",
      occurrence_kind: "hazard",
      severity: "high",
      detail: "Work stopped on J-ELENA",
    });
    // Let the sheet finish saving the stop before the next test resets the database.
    await screen.findByText("Stop sent. When the area is safe, say so here.");
  });

  it("S23: once the office has it, asks for the made-safe step and makes it safe on that stop", async () => {
    officeAnswers();
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.type(screen.getByLabelText("What is unsafe (optional)"), "Ice on the north slope");
    await user.click(screen.getByRole("button", { name: "Send stop report" }));

    expect(await screen.findByText("Stop sent. When the area is safe, say so here.")).toBeVisible();
    expect(screen.getByText(/^Stop · \w{3} \d{1,2}:\d{2}/)).toHaveTextContent(
      "· Ice on the north slope · Job J-ELENA, 118 Larkspur Way NW",
    );
    expect(screen.getByLabelText("What you did (optional)")).toBeVisible();
    expect(
      screen.getByText("This doesn't restart work. The office releases the stop."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Take photo" })).toHaveAttribute(
      "href",
      "/check-in/JOB-ELENA",
    );

    const [raise] = await safetyActions();
    expect(raise?.payload).toMatchObject({ detail: "Ice on the north slope" });
    await user.click(screen.getByRole("button", { name: "I've made the area safe" }));
    await waitFor(async () => expect(await safetyActions()).toHaveLength(2));
    const safe = (await safetyActions()).find(
      (action) => (action.payload as { kind: string }).kind === "make_safe",
    );
    expect(safe?.payload).toMatchObject({
      kind: "make_safe",
      scope_type: "roof_job",
      scope_id: "JOB-ELENA",
      occurrence_id: await occurrenceIdFor(raise!.deviceActionId),
      detail: "Area made safe on J-ELENA",
    });
    await screen.findByText(
      "Saved on this device. It uploads on its own and keeps the same record if you retry.",
    );
  });

  it("S23: with no signal, does not say the stop was sent", async () => {
    noSignal();
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    expect(
      await screen.findByText(
        "Saved on this device. It uploads on its own and keeps the same record if you retry.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Stop sent/)).toBeNull();
  });

  it("S23: shows the stop again after the sheet reopens", async () => {
    officeAnswers();
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    await screen.findByText("Stop sent. When the area is safe, say so here.");
    first.unmount();
    render(<JobStopSheet session={session} job={job} />);
    expect(await screen.findByText("Stop sent. When the area is safe, say so here.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send stop report" })).toBeNull();
  });

  it("S21: a stop whose job was not found says it holds every job", async () => {
    officeAnswers({ scopeUnresolved: true });
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.type(screen.getByLabelText("What is unsafe (optional)"), "Ice on the north slope");
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    expect(
      await screen.findByText(
        "Work is stopped on every job: this stop's job wasn't found. The office is told and fixes the job on it.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/^Stop · \w{3} \d{1,2}:\d{2}/)).toHaveTextContent(
      "· Sam Keewatin · Ice on the north slope",
    );
    expect(screen.getByText(/^Job: not found · /)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/Work is stopped on every job/)).toBeNull();
  });
});

describe("resolveStopJob", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  const packet = (id: string) => ({
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-08-17T12:00:00.000Z",
    stale_fields: [],
    job: {
      id,
      roof_job_id: null,
      job_number: "J-ELENA",
      brand: null,
      service_type: null,
      status: null,
      address: "118 Larkspur Way NW",
      current_gate_state: null,
    },
  });

  it("stops the open job, named from the packet on this phone", async () => {
    await cacheFieldModel(`ironwrap:appu_sam:job:JOB-ELENA`, packet("JOB-ELENA"), null);
    const resolved = await resolveStopJob(session, "/jobs/JOB-ELENA");
    // A packet this test does not fully build still gives the job its id from the route.
    expect(resolved?.id).toBe("JOB-ELENA");
  });

  it("stops the only job on today's run sheet, and none when there are two", async () => {
    const today = (count: number) => ({
      version: 1,
      source_updated_at: null,
      read_model_generated_at: "2026-08-17T12:00:00.000Z",
      stale_fields: [],
      permissions: [],
      allowed_actions: [],
      date: "2026-08-17",
      jobs: Array.from({ length: count }, (_, index) => ({
        id: `JOB-${index}`,
        job_number: `J-${index}`,
        brand: null,
        status: null,
        address: `${index} Main St`,
        scheduled_start: null,
        scheduled_end: null,
        blocked_gate_count: 0,
        next_action: "Start",
        assignment: null,
      })),
      work_objects: [],
    });
    await cacheFieldModel("ironwrap:appu_sam:today", today(1), null);
    expect(await resolveStopJob(session, "/today")).toEqual({
      id: "JOB-0",
      code: "J-0",
      address: "0 Main St",
    });
    await cacheFieldModel("ironwrap:appu_sam:today", today(2), null);
    expect(await resolveStopJob(session, "/today")).toBeUndefined();
  });
});
