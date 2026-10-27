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

/** The office's safety read, with these stops open. */
function panelFetcher(open: Array<{ occurrence_id: string; stop_active: boolean }>): typeof fetch {
  return (async () =>
    Response.json({
      version: 1,
      panel: {
        version: 1,
        actor_role: "field",
        assigned_equipment: [],
        open_occurrences: open.map((stop) => ({
          ...stop,
          occurrence_kind: "hazard",
          severity: "high",
          state: "reported",
          scope_type: "roof_job",
          scope_id: "JOB-ELENA",
          summary: "Work stopped on J-ELENA",
        })),
        my_corrective_actions: [],
        allowed_actions: [],
      },
    })) as unknown as typeof fetch;
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
    expect(await screen.findByText("Job J-ELENA · 118 Larkspur Way NW")).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
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
    await user.type(
      await screen.findByLabelText("What is unsafe (optional)"),
      "Ice on the north slope",
    );
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
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    expect(
      await screen.findByText(
        "Saved on this device. It uploads on its own and keeps the same record if you retry.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Stop sent/)).toBeNull();
  });

  it("S23: a stop the office has lifted is over, and the job offers a new stop", async () => {
    officeAnswers();
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText("Stop sent. When the area is safe, say so here.");
    first.unmount();
    render(<JobStopSheet session={session} job={job} fetcher={panelFetcher([])} />);
    expect(await screen.findByRole("button", { name: "Send stop report" })).toBeVisible();
  });

  it("S23: a stop still in force stays on screen", async () => {
    officeAnswers();
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText("Stop sent. When the area is safe, say so here.");
    first.unmount();
    const [raise] = await safetyActions();
    const active = [
      { occurrence_id: await occurrenceIdFor(raise!.deviceActionId), stop_active: true },
    ];
    render(<JobStopSheet session={session} job={job} fetcher={panelFetcher(active)} />);
    expect(await screen.findByText("Stop sent. When the area is safe, say so here.")).toBeVisible();
  });

  it("S23: a stop the office refused says so, never that it uploads on its own", async () => {
    vi.mocked(flushOutbox).mockImplementation(async () => {
      const database = await getDatabase();
      for (const action of await database.getAll("outbox_actions")) {
        await database.put("outbox_actions", { ...action, state: "needs_attention" });
      }
      return { processed: 1, verified: 0, requeued: 0, needsAttention: 1 };
    });
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    expect(
      await screen.findByText(
        "This phone could not confirm it saved this report. Tell your supervisor directly.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/uploads on its own/)).toBeNull();
  });

  it("S23: words too short to send are not shown as sent", async () => {
    officeAnswers();
    const user = userEvent.setup();
    render(<JobStopSheet session={session} job={job} />);
    await user.type(await screen.findByLabelText("What is unsafe (optional)"), "ok");
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    await screen.findByText("Stop sent. When the area is safe, say so here.");
    expect(screen.getByText(/^Stop · /)).not.toHaveTextContent("· ok ·");
    const [saved] = await safetyActions();
    expect(saved?.payload).toMatchObject({ detail: "Work stopped on J-ELENA" });
  });

  it("S23: shows the stop again after the sheet reopens", async () => {
    officeAnswers();
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText("Stop sent. When the area is safe, say so here.");
    first.unmount();
    render(<JobStopSheet session={session} job={job} />);
    expect(await screen.findByText("Stop sent. When the area is safe, say so here.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send stop report" })).toBeNull();
  });

  it("S21: a stop whose job was not found says it holds every job, then asks for the made-safe step", async () => {
    officeAnswers({ scopeUnresolved: true });
    const user = userEvent.setup();
    const onStage = vi.fn();
    render(<JobStopSheet session={session} job={job} onStage={onStage} />);
    await user.type(
      await screen.findByLabelText("What is unsafe (optional)"),
      "Ice on the north slope",
    );
    await user.click(screen.getByRole("button", { name: "Send stop report" }));
    expect(
      await screen.findByText(
        "This stop's job wasn't found, so work is stopped on every job. The office is told.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/^Stop · \w{3} \d{1,2}:\d{2}/)).toHaveTextContent(
      "· Sam Keewatin · Ice on the north slope",
    );
    expect(screen.getByText("Job: not found · The office is told")).toBeVisible();
    expect(screen.queryByText(/Stop sent/)).toBeNull();
    expect(onStage).toHaveBeenLastCalledWith("stopped");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/work is stopped on every job/)).toBeNull();
    expect(screen.getByRole("button", { name: "I've made the area safe" })).toBeVisible();
    // The stop still holds every job, so its line never names the job that wasn't found.
    expect(screen.getByText(/^Stop · .* · Every job$/)).toBeVisible();
    expect(screen.queryByText(new RegExp(`Job ${job.code}`))).toBeNull();
    expect(screen.queryByText(/Stop sent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send stop report" })).toBeNull();
    expect(onStage).toHaveBeenLastCalledWith("stopped");
  });

  it("S21: a stop the office has lifted is over, and the job offers a new stop", async () => {
    officeAnswers({ scopeUnresolved: true });
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText(/work is stopped on every job/);
    first.unmount();
    render(<JobStopSheet session={session} job={job} fetcher={panelFetcher([])} />);
    expect(await screen.findByRole("button", { name: "Send stop report" })).toBeVisible();
  });

  it("S21: a new stop shows S21 again after Done on a stop the office then lifted", async () => {
    officeAnswers({ scopeUnresolved: true });
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText(/work is stopped on every job/);
    first.unmount();
    // The office's read answers only after the crew has pressed Done: the stop was lifted.
    let answerPanel!: () => void;
    const slowPanel = (async (...args: Parameters<typeof fetch>) => {
      await new Promise<void>((resolve) => (answerPanel = resolve));
      return panelFetcher([])(...args);
    }) as typeof fetch;
    render(<JobStopSheet session={session} job={job} fetcher={slowPanel} />);
    await screen.findByText(/work is stopped on every job/);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/work is stopped on every job/)).toBeNull();
    answerPanel();
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    expect(await screen.findByText(/work is stopped on every job/)).toBeVisible();
  });

  it("S21: a stop waiting on this phone shows S21 once the office's answer comes in", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      noSignal();
      const user = userEvent.setup();
      render(<JobStopSheet session={session} job={job} />);
      await user.click(await screen.findByRole("button", { name: "Send stop report" }));
      await screen.findByText(
        "Saved on this device. It uploads on its own and keeps the same record if you retry.",
      );
      // Signal comes back and the office answers that the stop's job wasn't found.
      const database = await getDatabase();
      const [raise] = await safetyActions();
      await database.put("outbox_actions", {
        ...raise!,
        state: "verified",
        verification: { verifiedAt: Date.now(), scopeUnresolved: true },
      });
      vi.advanceTimersByTime(5_000);
      expect(await screen.findByText(/work is stopped on every job/)).toBeVisible();
      expect(screen.queryByText(/uploads on its own/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("S21: comes back on the next open while the stop holds", async () => {
    officeAnswers({ scopeUnresolved: true });
    const user = userEvent.setup();
    const first = render(<JobStopSheet session={session} job={job} />);
    await user.click(await screen.findByRole("button", { name: "Send stop report" }));
    await screen.findByText(/work is stopped on every job/);
    first.unmount();
    const [raise] = await safetyActions();
    const active = [
      { occurrence_id: await occurrenceIdFor(raise!.deviceActionId), stop_active: true },
    ];
    render(<JobStopSheet session={session} job={job} fetcher={panelFetcher(active)} />);
    expect(await screen.findByText(/work is stopped on every job/)).toBeVisible();
  });
});

describe("resolveStopJob", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  // Noon in Calgary on 2026-08-17.
  const noon = new Date("2026-08-17T18:00:00.000Z");
  const packet = {
    job: { id: "JOB-ELENA", job_number: "J-ELENA", address: "118 Larkspur Way NW" },
  };
  const today = (count: number, date = "2026-08-17") => ({
    date,
    jobs: Array.from({ length: count }, (_, index) => ({
      id: `JOB-${index}`,
      job_number: `J-${index}`,
      address: `${index} Main St`,
    })),
  });

  it("stops the open job, named from the packet on this phone", async () => {
    await cacheFieldModel("ironwrap:appu_sam:job:JOB-ELENA", packet, null);
    expect(await resolveStopJob(session, "/jobs/JOB-ELENA", noon)).toEqual(job);
    expect(await resolveStopJob(session, "/check-in/JOB-ELENA", noon)).toEqual(job);
  });

  it("names the job by its id when this phone has no packet for it", async () => {
    expect(await resolveStopJob(session, "/jobs/JOB-X", noon)).toEqual({
      id: "JOB-X",
      code: "JOB-X",
      address: null,
    });
  });

  it("never stops a finished job's history or a screen that is not a job", async () => {
    await cacheFieldModel("ironwrap:appu_sam:today", today(1), null);
    expect(await resolveStopJob(session, "/jobs/JOB-ELENA/history", noon)).toBeUndefined();
    expect(await resolveStopJob(session, "/vehicle", noon)).toBeUndefined();
    expect(await resolveStopJob(session, "/work-objects/a/b", noon)).toBeUndefined();
  });

  it("on a home screen stops the only job on today's run sheet, and none otherwise", async () => {
    await cacheFieldModel("ironwrap:appu_sam:today", today(1), null);
    expect(await resolveStopJob(session, "/today", noon)).toEqual({
      id: "JOB-0",
      code: "J-0",
      address: "0 Main St",
    });
    await cacheFieldModel("ironwrap:appu_sam:today", today(2), null);
    expect(await resolveStopJob(session, "/today", noon)).toBeUndefined();
    // Yesterday's run sheet is not today's job.
    await cacheFieldModel("ironwrap:appu_sam:today", today(1, "2026-08-16"), null);
    expect(await resolveStopJob(session, "/today", noon)).toBeUndefined();
  });

  it("derives the occurrence id the way the Worker does", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await occurrenceIdFor("abc")).toBe("so_ba7816bf8f01cfea414140de5dae2223");
  });
});
