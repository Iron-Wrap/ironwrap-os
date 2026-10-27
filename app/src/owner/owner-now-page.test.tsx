import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import type {
  MeasurementIntakeOwnerExceptionsResponse,
  OwnerNowResponse,
  OwnerRuntimeResponse,
} from "./owner-contracts";
import { loadMeasurementIntakeExceptions, loadOwnerNow, loadOwnerRuntime } from "./owner-api";
import { OwnerNowPage } from "./owner-now-page";
import { buildDecisionLanes, formatOwnerDate, validJobId } from "./owner-now-utils";

vi.mock("./owner-api", () => ({
  loadOwnerNow: vi.fn(),
  loadMeasurementIntakeExceptions: vi.fn(),
  loadOwnerRuntime: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} href={to === "/jobs/$jobId" && params?.jobId ? `/jobs/${params.jobId}` : to}>
      {children}
    </a>
  ),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.test",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["owner.now.read"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const noLeadEvidence = {
  received_at: null,
  bus_status: null,
  triage_status: null,
  mctb: null,
} as const;

function ownerNowModel(): OwnerNowResponse {
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    stale_fields: ["exceptions.next_action", "exceptions.due_at"],
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    exceptions: [
      {
        id: "checkin_blocked",
        kind: "field_blocker",
        severity: null,
        title: "Weather work-stop reported",
        why: "Wind exceeds the site plan limit.",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: "2026-07-10 10:05:00",
        due_at: null,
        ...noLeadEvidence,
      },
      {
        id: "lead_a",
        kind: "untriaged_lead",
        severity: null,
        title: "Untriaged lead: Leslie",
        why: "Website estimate request",
        next_action: null,
        job_id: null,
        occurred_at: "2026-07-10T11:00:00.000Z",
        due_at: null,
        received_at: "2026-07-10T11:00:00.000Z",
        bus_status: "pushed",
        triage_status: "Untriaged",
        mctb: {
          state: "provider_accepted_within_sla",
          deadline_at: "2026-07-10T11:01:00.000Z",
          observed_at: "2026-07-10T11:00:45.000Z",
          channel: "email",
          proof_kind: "provider_receipt",
        },
      },
      {
        id: "lead_unknown",
        kind: "lead_triage_unknown",
        severity: null,
        title: "Lead triage is unknown: Morgan",
        why: "Website estimate request",
        next_action: null,
        job_id: null,
        occurred_at: "2026-07-10T11:05:00.000Z",
        due_at: null,
        received_at: "2026-07-10T11:05:00.000Z",
        bus_status: "pushed",
        triage_status: "Unknown",
        mctb: {
          state: "unproven_after_sla",
          deadline_at: "2026-07-10T11:06:00.000Z",
          observed_at: null,
          channel: null,
          proof_kind: null,
        },
      },
      {
        id: "gate_later",
        kind: "blocked_gate",
        severity: null,
        title: "Permit gate blocked",
        why: "Permit confirmation missing",
        next_action: null,
        job_id: "JOB-LATER",
        occurred_at: null,
        due_at: "2026-07-12 09:00:00",
        ...noLeadEvidence,
      },
      {
        id: "incident_a",
        kind: "automation_incident",
        severity: "Critical",
        title: "QuickBooks replay stalled",
        why: "Webhook receipt is unresolved",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: "2026-07-10T17:30:00.000Z",
        due_at: "2026-07-10T18:00:00.000Z",
        ...noLeadEvidence,
      },
      {
        id: "gate_first",
        kind: "blocked_gate",
        severity: null,
        title: "Materials gate blocked",
        why: "Delivery not confirmed",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: null,
        due_at: "2026-07-11 12:00:00",
        ...noLeadEvidence,
      },
      {
        id: "material_a",
        kind: "material_exception",
        severity: null,
        title: "Supplier order shortage",
        why: "Shingle quantity mismatch",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: null,
        due_at: null,
        ...noLeadEvidence,
      },
      {
        id: "payment_a",
        kind: "finance_exception",
        severity: null,
        title: "Deposit needs review",
        why: "Webhook received",
        next_action: null,
        job_id: "../../not-a-job",
        occurred_at: null,
        due_at: null,
        ...noLeadEvidence,
      },
    ],
    partial_sources: ["field_blockers", "material_exceptions"],
    summary: {
      active_jobs: 3,
      field_blockers: 1,
      blocked_gates: 2,
      open_incidents: 1,
      finance_exceptions: 1,
      untriaged_leads: 1,
      lead_triage_unknown: 1,
      mctb_unproven_due: 1,
      material_exceptions: 1,
    },
  };
}

function measurementExceptionsModel(): MeasurementIntakeOwnerExceptionsResponse {
  return {
    measurements: [
      {
        id: `measurement_${"c".repeat(64)}`,
        provider: "RoofRuler",
        job_number: null,
        status: "unmatched",
        reason: "job_number_missing",
        drive_report_url: "https://drive.google.com/open?id=report-a",
        drive_folder_url: "https://drive.google.com/drive/folders/folder-a",
        attempts: 1,
        recovery_disposition: "manual_review",
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:01:00.000Z",
      },
      {
        id: `measurement_${"d".repeat(64)}`,
        provider: "AppliCad",
        job_number: "26-0042",
        status: "retryable_error",
        reason: "report_fetch_failed",
        drive_report_url: "https://not-drive.example.invalid/report",
        drive_folder_url: null,
        attempts: 3,
        recovery_disposition: "retry_scheduled",
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:02:00.000Z",
      },
    ],
  };
}

function ownerRuntimeModel(): OwnerRuntimeResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    status: "attention",
    readiness: {
      status: "not_ready",
      checks: [
        { id: "owned_persistence", ok: true },
        { id: "queue", ok: true },
        { id: "core_auth", ok: true },
        { id: "provider_delivery", ok: true },
        { id: "office_bff", ok: false },
        { id: "customer_portal", ok: true },
        { id: "production_schedule", ok: true },
        { id: "public_estimate", ok: true },
        { id: "newo", ok: true },
      ],
    },
    operations: {
      status: "degraded",
      heartbeat: null,
      counts: {
        open_dead_letters: 1,
        pending: 0,
        stuck: 2,
        frappe_errors: 0,
        replay_failed: 0,
        replay_stuck: 1,
      },
      audit_failures_observed: 1,
      audit_failure_window_hours: 24,
      quickbooks_receipts: {
        available: false,
        fresh: null,
        age_seconds: null,
        events_count: null,
        replay_count: null,
      },
    },
  };
}

function renderOwner({
  session = ownerSession,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: {
  session?: AuthenticatedSession;
  client?: QueryClient;
} = {}) {
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <OwnerNowPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("OwnerNowPage", () => {
  beforeEach(() => {
    vi.mocked(loadOwnerNow).mockResolvedValue(ownerNowModel());
    vi.mocked(loadMeasurementIntakeExceptions).mockResolvedValue(measurementExceptionsModel());
    vi.mocked(loadOwnerRuntime).mockResolvedValue(ownerRuntimeModel());
  });

  it("turns proof-safe exceptions into a decision board without fabricating actions or delivery", async () => {
    const { container } = renderOwner();

    await screen.findByRole("heading", { name: "Work stopped" });

    expect(
      Array.from(container.querySelectorAll('[aria-labelledby^="owner-decision-lane-"]')).map(
        (section) => section.getAttribute("aria-labelledby"),
      ),
    ).toEqual([
      "owner-decision-lane-work_stopped",
      "owner-decision-lane-operating_exceptions",
      "owner-decision-lane-lead_attention",
    ]);
    expect(screen.getAllByText("Work stopped").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Needs a check").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Lead checks").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Work data updated").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Not known").length).toBeGreaterThan(1);
    expect(screen.getAllByText("The next step is missing from this list.").length).toBeGreaterThan(
      1,
    );
    expect(screen.getAllByText("Some due times are missing.").length).toBeGreaterThan(1);
    expect(
      screen.getAllByText(/Some counts may be low for Field Blockers, Material Exceptions/i).length,
    ).toBeGreaterThan(1);
    expect(screen.getAllByText("Reply proof").length).toBeGreaterThan(1);
    expect(screen.queryByText("New leads")).not.toBeInTheDocument();
    expect(screen.queryByText(/sent|delivered|human follow-up/i)).not.toBeInTheDocument();
    expect(screen.queryByText("No verified next action was returned.")).not.toBeInTheDocument();

    expect(screen.getAllByRole("link", { name: "Open job JOB-A" })[0]!).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(screen.queryByRole("link", { name: /not-a-job/i })).not.toBeInTheDocument();
  });

  it("signals held work in red and work that needs you in blue, and leaves zero counts plain", async () => {
    vi.mocked(loadOwnerNow).mockResolvedValue({
      ...ownerNowModel(),
      summary: {
        ...ownerNowModel().summary,
        open_incidents: 0,
        material_exceptions: 0,
        finance_exceptions: 0,
      },
    });
    renderOwner();
    const summary = await screen.findByLabelText("Work to check");
    const valueOf = (label: string) =>
      within(summary).getByText(label).closest("div")!.querySelector("dd")!;
    expect(valueOf("Work stopped")).toHaveClass("text-danger");
    expect(valueOf("Lead checks")).toHaveClass("text-signal-you");
    expect(valueOf("Needs a check")).toHaveClass("text-foreground");
    expect(valueOf("Needs a check")).not.toHaveClass("text-signal-you");
  });

  it("keeps long lanes scannable until the owner asks for the remaining work", async () => {
    const next = ownerNowModel();
    const blocked = next.exceptions[0]!;
    next.exceptions = Array.from({ length: 8 }, (_, index) => ({
      ...blocked,
      id: `blocked-${index}`,
      title: `Blocked job ${index + 1}`,
      job_id: `JOB-${index + 1}`,
    }));
    vi.mocked(loadOwnerNow).mockResolvedValueOnce(next);
    renderOwner();

    await screen.findByText("Blocked job 1");
    expect(screen.getByText("Blocked job 3")).toBeVisible();
    expect(screen.queryByText("Blocked job 4")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getByText("Blocked job 7")).toBeVisible();
    expect(screen.getByText("Blocked job 8")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("turns missing native facts into an operator-facing data warning", async () => {
    const next = ownerNowModel();
    next.stale_fields.push("economics.change_order.native_unavailable");
    vi.mocked(loadOwnerNow).mockResolvedValueOnce(next);
    renderOwner();

    expect(
      (await screen.findAllByText("Change Order could not be checked.")).length,
    ).toBeGreaterThan(1);
    expect(screen.queryByText(/economics\.change_order/i)).not.toBeInTheDocument();
  });

  it("gates job access on the server-backed capability rather than showing a disabled control", async () => {
    const noJobAccess = ownerNowModel();
    noJobAccess.allowed_actions = [];
    vi.mocked(loadOwnerNow).mockResolvedValueOnce(noJobAccess);
    renderOwner();

    await screen.findByRole("heading", { name: "Work stopped" });
    expect(screen.queryByRole("link", { name: /Open job packet/i })).not.toBeInTheDocument();
  });

  it("shows durable measurement exceptions without exposing raw receipt data or trusting arbitrary links", async () => {
    const { container } = renderOwner();

    expect(await screen.findByRole("heading", { name: "Roof reports to check" })).toBeVisible();
    expect(screen.getByText("RoofRuler report needs a job")).toBeVisible();
    expect(screen.getByText("AppliCad report will try again")).toBeVisible();
    expect(screen.getByText(/report has no job number/i)).toBeVisible();
    expect(screen.getByText(/could not get the roof report/i)).toBeVisible();
    expect(screen.getByText(/will try again at the saved time/i)).toBeVisible();
    expect(screen.getByText("Tries:")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open report" })).toHaveAttribute(
      "href",
      "https://drive.google.com/open?id=report-a",
    );
    expect(screen.getByRole("link", { name: "Open folder" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByRole("link", { name: /not-drive/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(`measurement_${"c".repeat(64)}`);
    expect(container.textContent).not.toContain("raw_key");
  });

  it("does not promise retries for blocked or exhausted measurement recovery", async () => {
    const exceptions = measurementExceptionsModel();
    const retryable = exceptions.measurements[1]!;
    exceptions.measurements[1] = {
      ...retryable,
      reason: "raw_source_missing",
      attempts: 12,
      recovery_disposition: "recovery_blocked",
    };
    exceptions.measurements.push({
      id: `measurement_${"e".repeat(64)}`,
      provider: "RoofRuler",
      job_number: "26-0043",
      status: "retryable_error",
      reason: "report_fetch_failed",
      drive_report_url: null,
      drive_folder_url: null,
      attempts: 12,
      recovery_disposition: "retry_exhausted",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:03:00.000Z",
    });
    vi.mocked(loadMeasurementIntakeExceptions).mockResolvedValueOnce(exceptions);

    renderOwner();

    expect(await screen.findByText("AppliCad report needs help")).toBeVisible();
    expect(screen.getByText("RoofRuler report needs help")).toBeVisible();
    expect(screen.getByText("Help needed")).toBeVisible();
    expect(screen.getByText("No more tries")).toBeVisible();
    expect(screen.getByText(/saved roof report is missing/i)).toBeVisible();
    expect(screen.getByText(/app cannot try again/i)).toBeVisible();
    expect(screen.getByText(/app has used all tries/i)).toBeVisible();
    expect(screen.queryByText("Will try again")).not.toBeInTheDocument();
  });

  it("distinguishes OCR review from job matching", async () => {
    const exceptions = measurementExceptionsModel();
    exceptions.measurements = [
      {
        ...exceptions.measurements[0]!,
        job_number: "26-0044",
        reason: "ocr_review_required",
      },
    ];
    vi.mocked(loadMeasurementIntakeExceptions).mockResolvedValueOnce(exceptions);

    renderOwner();

    expect(await screen.findByText("RoofRuler report needs a text check")).toBeVisible();
    expect(screen.getByText(/check them against the saved report/i)).toBeVisible();
    expect(screen.queryByText(/needs a job$/i)).not.toBeInTheDocument();
  });

  it("keeps an empty measurement queue honest", async () => {
    vi.mocked(loadMeasurementIntakeExceptions).mockResolvedValueOnce({ measurements: [] });
    renderOwner();

    expect(await screen.findByText("No roof reports need a check.")).toBeVisible();
  });

  it("keeps a prior read visible when refresh fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["owner-now", "ironwrap", "appu_owner"], ownerNowModel());
    vi.mocked(loadOwnerNow).mockRejectedValueOnce(new Error("upstream unavailable"));

    renderOwner({ client });

    expect(await screen.findByText("This may be an old list.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Work stopped" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load again" })).toBeVisible();
  });

  it("uses an honest empty state when a bounded source returns no exception rows", async () => {
    const empty = ownerNowModel();
    empty.exceptions = [];
    empty.summary = {
      active_jobs: 3,
      field_blockers: 0,
      blocked_gates: 0,
      open_incidents: 0,
      finance_exceptions: 0,
      untriaged_leads: 0,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 0,
    };
    vi.mocked(loadOwnerNow).mockResolvedValueOnce(empty);

    renderOwner();

    expect(
      await screen.findByRole("heading", {
        name: "No work was found in the data we have",
      }),
    ).toBeVisible();
  });

  it("shows the route-specific retry state when no read is available", async () => {
    vi.mocked(loadOwnerNow).mockRejectedValueOnce(new Error("upstream unavailable"));

    renderOwner();

    expect(
      await screen.findByRole("heading", { name: "Today's work could not load" }),
    ).toBeVisible();
    expect(screen.getByText(/Nothing changed. Check your link/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Load again" })).toBeVisible();
  });

  it("keeps the existing owner/ops access semantics for operations", async () => {
    const opsSession = {
      ...ownerSession,
      user: { ...ownerSession.user, role: "ops" as const },
    };

    renderOwner({ session: opsSession });

    expect(await screen.findByRole("heading", { name: "Now" })).toBeVisible();
    expect(loadOwnerNow).toHaveBeenCalledOnce();
  });

  it("runs the bounded runtime read only after the owner asks for it", async () => {
    const user = userEvent.setup();
    renderOwner();

    await screen.findByRole("button", { name: "Run system check" });
    expect(loadOwnerRuntime).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run system check" }));

    expect(await screen.findByText("Items to fix")).toBeVisible();
    expect(screen.getByText("Messages not finished")).not.toBeVisible();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("Messages not finished")).toBeVisible();
    expect(screen.getByText("Save record errors in 24 hours")).toBeVisible();
    expect(screen.getByText("Checks to fix: Office app link.")).toBeVisible();
    expect(loadOwnerRuntime).toHaveBeenCalledOnce();
  });

  it("puts a work stop naming a job or job plan that doesn't exist first, with who raised it (N1, N1b)", async () => {
    const base = ownerNowModel();
    const stop = (kind: string, title: string, id: string) => ({
      id,
      kind,
      severity: null,
      title,
      why: "Safety and scheduling stay held on every job while this work stop is active.",
      next_action: null,
      job_id: null,
      occurred_at: "2026-07-10T16:05:00.000Z",
      due_at: null,
      ...noLeadEvidence,
      reported_by_name: kind === "stop_job_unknown" ? "Sam Keewatin" : null,
      summary: "Soft deck boards by the back stairs. Crew is off the roof.",
    });
    vi.mocked(loadOwnerNow).mockResolvedValue({
      ...base,
      exceptions: [
        ...base.exceptions,
        stop("stop_job_unknown", "This work stop names a job that doesn’t exist", "occ_job"),
        stop(
          "stop_work_package_unknown",
          "This work stop names a job plan that doesn’t exist",
          "occ_plan",
        ),
      ],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T18:00:00.000Z"));
    renderOwner();

    const heading = await screen.findByRole("heading", { level: 2, name: "Work stopped" });
    const list = document.getElementById(`${heading.id}-items`)!;
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("This work stop names a job");
    expect(items[1]).toHaveTextContent("This work stop names a job");
    expect(
      screen.getAllByText(
        "Safety and scheduling stay held on every job while this work stop is active.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("Sam Keewatin · Today 10:05")).toBeVisible();
    expect(screen.getByText("Name not on record · Today 10:05")).toBeVisible();
    expect(
      screen.getAllByText("“Soft deck boards by the back stairs. Crew is off the roof.”"),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        "Releasing it, or raising it again on the right job, isn’t in the app yet. Clearing it needs IronWrap support.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Releasing it, or raising it again on the right job plan, isn’t in the app yet. Clearing it needs IronWrap support.",
      ),
    ).toBeVisible();
    expect(within(items[0]!).queryByRole("link")).not.toBeInTheDocument();
    expect(within(items[0]!).queryByRole("button")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps lane order, dates, and job links deterministic and defensive", () => {
    const lanes = buildDecisionLanes(ownerNowModel().exceptions, { dueTimingAvailable: false });

    expect(lanes.map((lane) => lane.id)).toEqual([
      "work_stopped",
      "operating_exceptions",
      "lead_attention",
    ]);
    expect(lanes[0]?.exceptions.map((exception) => exception.id)).toEqual([
      "gate_first",
      "gate_later",
      "checkin_blocked",
    ]);
    expect(validJobId("JOB-A")).toBe(true);
    expect(validJobId("../../not-a-job")).toBe(false);
    expect(formatOwnerDate("2026-02-30")).toBe("Date unavailable");
    expect(
      formatOwnerDate("2026-07-10 10:05:00", {
        locale: "en-CA",
        timeZone: "America/Edmonton",
      }),
    ).toMatch(/Jul 10, 2026 · 10:05/);
    expect(
      formatOwnerDate("2026-07-10T12:00:00.000Z", {
        locale: "en-CA",
        timeZone: "America/Edmonton",
      }),
    ).toMatch(/6:00/);
  });
});
