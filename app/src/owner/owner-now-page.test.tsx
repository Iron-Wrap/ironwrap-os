import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
      Array.from(
        container.querySelectorAll('section[aria-labelledby^="owner-decision-lane-"]'),
      ).map((section) => section.getAttribute("aria-labelledby")),
    ).toEqual([
      "owner-decision-lane-work_stopped",
      "owner-decision-lane-operating_exceptions",
      "owner-decision-lane-lead_attention",
    ]);
    expect(screen.getAllByText("Work stopped").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Lead attention").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Source update").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(1);
    expect(
      screen.getAllByText("Action guidance is unavailable in this read-only queue.").length,
    ).toBeGreaterThan(1);
    expect(screen.getAllByText("Some due timing is unavailable.").length).toBeGreaterThan(1);
    expect(
      screen.getAllByText(/Counts are lower bounds for Field Blockers, Material Exceptions/i)
        .length,
    ).toBeGreaterThan(1);
    expect(screen.getAllByText("Acknowledgement evidence").length).toBeGreaterThan(1);
    expect(screen.queryByText("New leads")).not.toBeInTheDocument();
    expect(screen.queryByText(/sent|delivered|human follow-up/i)).not.toBeInTheDocument();
    expect(screen.queryByText("No verified next action was returned.")).not.toBeInTheDocument();

    expect(screen.getAllByRole("link", { name: "Open job packet for JOB-A" })[0]!).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(screen.queryByRole("link", { name: /not-a-job/i })).not.toBeInTheDocument();
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

    expect(
      await screen.findByRole("heading", { name: "Measurement reports needing attention" }),
    ).toBeVisible();
    expect(screen.getByText("RoofRuler report needs a job match")).toBeVisible();
    expect(screen.getByText("AppliCad report is retrying")).toBeVisible();
    expect(screen.getByText(/No job number was supplied/i)).toBeVisible();
    expect(screen.getByText(/report source could not be fetched/i)).toBeVisible();
    expect(screen.getByText(/will retry automatically when due/i)).toBeVisible();
    expect(screen.getByText("Attempts:")).toBeVisible();
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

    expect(await screen.findByText("AppliCad report needs recovery")).toBeVisible();
    expect(screen.getByText("RoofRuler report needs recovery")).toBeVisible();
    expect(screen.getByText("Recovery blocked")).toBeVisible();
    expect(screen.getByText("Retry limit reached")).toBeVisible();
    expect(screen.getByText(/saved raw source is unavailable/i)).toBeVisible();
    expect(screen.getByText(/Automatic recovery is blocked/i)).toBeVisible();
    expect(screen.getByText(/automatic retry limit has been reached/i)).toBeVisible();
    expect(screen.queryByText("Automatic retry")).not.toBeInTheDocument();
  });

  it("keeps an empty measurement queue honest", async () => {
    vi.mocked(loadMeasurementIntakeExceptions).mockResolvedValueOnce({ measurements: [] });
    renderOwner();

    expect(
      await screen.findByText("No unmatched or retryable measurement reports were returned."),
    ).toBeVisible();
  });

  it("keeps a prior read visible when refresh fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["owner-now", "ironwrap", "appu_owner"], ownerNowModel());
    vi.mocked(loadOwnerNow).mockRejectedValueOnce(new Error("upstream unavailable"));

    renderOwner({ client });

    expect(await screen.findByText("Showing the previous read.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Work stopped" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry queue" })).toBeVisible();
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
        name: "No exceptions were returned from available sources",
      }),
    ).toBeVisible();
  });

  it("shows the route-specific retry state when no read is available", async () => {
    vi.mocked(loadOwnerNow).mockRejectedValueOnce(new Error("upstream unavailable"));

    renderOwner();

    expect(await screen.findByRole("heading", { name: "Current queue unavailable" })).toBeVisible();
    expect(screen.getByText(/Retrying does not change jobs or acknowledgements/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry queue" })).toBeVisible();
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

    await screen.findByRole("button", { name: "Check runtime truth" });
    expect(loadOwnerRuntime).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check runtime truth" }));

    expect(await screen.findByText("Open dead letters")).toBeVisible();
    expect(screen.getByText("Audit failures observed (24h, max 20)")).toBeVisible();
    expect(screen.getByText("Readiness attention: office bff.")).toBeVisible();
    expect(loadOwnerRuntime).toHaveBeenCalledOnce();
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
