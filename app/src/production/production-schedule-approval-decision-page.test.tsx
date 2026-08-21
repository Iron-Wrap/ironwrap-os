import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadProductionRunway } from "./production-api";
import type { ProductionRunwayResponse } from "./production-contracts";
import {
  approveProductionScheduleApproval,
  loadProductionScheduleApproval,
  loadProductionScheduleApprovals,
  newProductionScheduleApprovalDecisionKey,
  reconcileProductionScheduleApproval,
  rejectProductionScheduleApproval,
} from "./production-schedule-approval-api";
import type {
  ProductionScheduleApprovalDetailResponse,
  ProductionScheduleApprovalListResponse,
  ProductionScheduleApprovalRequest,
} from "./production-schedule-approval-contracts";
import {
  ProductionScheduleApprovalDetailPage,
  ProductionScheduleApprovalQueuePage,
} from "./production-schedule-approval-decision-page";

const router = vi.hoisted(() => ({
  params: {} as { approvalId?: string },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { approvalId?: string };
  }) => <a href={to.replace("$approvalId", params?.approvalId ?? "$approvalId")}>{children}</a>,
  useParams: () => router.params,
  useNavigate: () => router.navigate,
}));
vi.mock("./production-api", () => ({ loadProductionRunway: vi.fn() }));
vi.mock("./production-schedule-approval-api", () => ({
  approveProductionScheduleApproval: vi.fn(),
  loadProductionScheduleApproval: vi.fn(),
  loadProductionScheduleApprovals: vi.fn(),
  newProductionScheduleApprovalDecisionKey: vi.fn(),
  reconcileProductionScheduleApproval: vi.fn(),
  rejectProductionScheduleApproval: vi.fn(),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["production:read"],
  allowed_actions: ["production_schedule_approval.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-20T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-20T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function request(
  overrides: Partial<ProductionScheduleApprovalRequest> = {},
): ProductionScheduleApprovalRequest {
  return {
    id: "production-schedule-approval:ui-001",
    kind: "production_schedule",
    state: "pending",
    version: 1,
    action: "create_job_assignment",
    roof_job_id: "JOB-001",
    target: { doctype: "Job Assignment", assignment_id: "assignment:001" },
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-20T14:00:00.000Z",
    scheduled_end: null,
    supersedes_assignment_id: null,
    correction_reason: null,
    request_text: "Schedule the active production job with the selected crew.",
    preview: {
      would_write: false,
      append_only: true,
      target: { doctype: "Job Assignment", assignment_id: "assignment:001" },
      assignment: {
        assignment_id: "assignment:001",
        roof_job_id: "JOB-001",
        crew_profile_id: "crew:metal-1",
        scheduled_start: "2026-07-20T14:00:00.000Z",
        scheduled_end: null,
        supersedes_assignment_id: null,
        correction_reason: null,
      },
      production_schedule_gate_preview: { required: true, state_eligible: true },
      effects: {
        crew_notified: false,
        customer_notified: false,
        accounting_mutated: false,
      },
    },
    expires_at: "2026-07-20T13:00:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:production-schedule:ui-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    refusal_message: null,
    reconciliation: null,
    created_at: "2026-07-19T12:00:00.000Z",
    updated_at: "2026-07-19T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function runwayModel(): ProductionRunwayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-20T12:00:00.000Z",
    read_model_generated_at: "2026-07-20T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read"],
    partial_sources: [],
    summary: {
      active_jobs: 1,
      blocked: 0,
      scheduled: 1,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [
      {
        id: "JOB-001",
        job_number: "IW-1001",
        brand: "IronWrap Exteriors",
        service_type: "Roofing",
        status: "In Production",
        version: 1,
        assignment: {
          id: "assignment:001",
          type: "Production",
          status: "Assigned",
          assignment_version: 1,
          roof_job_version: 1,
          crew_id: "crew:metal-1",
          crew_version: 1,
          scheduled_start: "2026-07-20T14:00:00.000Z",
          scheduled_end: null,
        },
        scheduling_preparation_allowed: true,
        lane: "scheduled",
        next_action: "Review a bounded schedule request.",
        gate_coverage: "complete",
        gate_summary: { expected: 6, blocked: 0, ready: 6, waived: 0, done: 0 },
        scheduling_gates: [
          { name: "Deposit", state: "Ready" },
          { name: "Materials", state: "Ready" },
          { name: "Safety", state: "Ready" },
          { name: "Access", state: "Ready" },
          { name: "Weather", state: "Ready" },
          { name: "Crew", state: "Ready" },
        ],
        material_attention: [],
      },
    ],
    crews: [{ id: "crew:metal-1", name: "Metal crew one", version: 1 }],
  };
}

function expectNotInFirstView(text: string | RegExp) {
  const firstView = screen.queryAllByText(text).filter((match) => {
    const details = match.closest("details");
    return !details || details.open;
  });
  expect(firstView).toEqual([]);
}

function firstViewHidesSystemIds() {
  expectNotInFirstView(/Hermes/i);
  expectNotInFirstView(/broker/i);
  expectNotInFirstView("JOB-001");
  expectNotInFirstView("crew:metal-1");
  expectNotInFirstView("assignment:001");
  expectNotInFirstView("2026-07-20T14:00:00.000Z");
  expectNotInFirstView("run:production-schedule:ui-001");
  expect(screen.queryByText("create_job_assignment")).not.toBeInTheDocument();
}

function listModel(
  approval = request(),
  allowedActions = ["production_schedule_approval.read"],
): ProductionScheduleApprovalListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-20T12:00:00.000Z",
    permissions: ["production:read"],
    allowed_actions: allowedActions as ProductionScheduleApprovalListResponse["allowed_actions"],
    approvals: [approval],
  };
}

function detailModel(
  approval = request(),
  allowedActions = ["production_schedule_approval.read"],
): ProductionScheduleApprovalDetailResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-20T12:00:00.000Z",
    permissions: ["production:read"],
    allowed_actions: allowedActions as ProductionScheduleApprovalDetailResponse["allowed_actions"],
    approval,
  };
}

function renderPage(children: ReactNode, session = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>{children}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe("ProductionScheduleApprovalDecisionPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.params = { approvalId: "production-schedule-approval:ui-001" };
    vi.mocked(loadProductionScheduleApprovals).mockResolvedValue(listModel());
    vi.mocked(loadProductionScheduleApproval).mockResolvedValue(detailModel());
    vi.mocked(loadProductionRunway).mockResolvedValue(runwayModel());
    vi.mocked(newProductionScheduleApprovalDecisionKey).mockReturnValue(
      "production-schedule-approval:decision-ui-001",
    );
  });

  it("lists prepared schedule requests without exposing broker internals", async () => {
    const { container } = renderPage(<ProductionScheduleApprovalQueuePage />);

    await screen.findByRole("heading", { name: "Schedule requests" });
    expect(screen.getByText("Job IW-1001")).toBeVisible();
    expect(screen.getByText("Crew Metal crew one")).toBeVisible();
    expect(screen.getByText(/does not notify the crew/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /job iw-1001 crew metal crew one/i })).toHaveAttribute(
      "href",
      "/production/schedule-approvals/production-schedule-approval:ui-001",
    );
    firstViewHidesSystemIds();
    expect(container.textContent).not.toMatch(/dry_run_receipt|write_args_json|tool_name/i);
  });

  it("does not infer approval authority from the role when the server omits the decision action", async () => {
    vi.mocked(loadProductionScheduleApproval).mockResolvedValue(
      detailModel(request(), ["production_schedule_approval.read"]),
    );
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    expect(
      screen.queryByRole("button", { name: "Approve crew assignment" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the designated approver/i)).toBeVisible();
  });

  it("posts approve to the recorded request with the caller-stable idempotency key", async () => {
    const user = userEvent.setup();
    const pending = request();
    const executed = request({
      state: "executed",
      version: 2,
      hermes_run_id: "run:production-schedule:ui-001",
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2026-07-20T12:01:00.000Z",
      },
      outcome: {
        run_id: "run:production-schedule:ui-001",
        created: true,
        assignment_id: "assignment:001",
        roof_job_id: "JOB-001",
        crew_profile_id: "crew:metal-1",
        scheduled_start: "2026-07-20T14:00:00.000Z",
        scheduled_end: null,
        supersedes_assignment_id: null,
        audit_finalized: true,
        crew_notified: false,
        customer_notified: false,
        accounting_mutated: false,
      },
    });
    vi.mocked(loadProductionScheduleApproval)
      .mockResolvedValueOnce(
        detailModel(pending, [
          "production_schedule_approval.read",
          "production_schedule_approval.approve",
          "production_schedule_approval.reject",
        ]),
      )
      .mockResolvedValue(
        detailModel(executed, [
          "production_schedule_approval.read",
          "production_schedule_approval.approve",
        ]),
      );
    vi.mocked(approveProductionScheduleApproval).mockResolvedValue({ approval: executed });
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    await user.click(screen.getByRole("button", { name: "Approve crew assignment" }));

    await waitFor(() => {
      expect(approveProductionScheduleApproval).toHaveBeenCalledWith(
        ownerSession,
        "production-schedule-approval:ui-001",
        1,
        "production-schedule-approval:decision-ui-001",
      );
    });
    expect(rejectProductionScheduleApproval).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/the crew assignment is saved. the schedule service recorded/i),
    ).toBeVisible();
    expect(screen.getAllByText("IW-1001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Metal crew one").length).toBeGreaterThan(0);
    firstViewHidesSystemIds();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("JOB-001")).toBeVisible();
    expect(screen.getByText("crew:metal-1")).toBeVisible();
    expect(screen.getByText("assignment:001")).toBeVisible();
    expect(screen.getAllByText("run:production-schedule:ui-001").length).toBeGreaterThan(0);
  });

  it("posts reject to the recorded request with the caller-stable idempotency key", async () => {
    const user = userEvent.setup();
    const pending = request();
    const denied = request({
      state: "denied",
      version: 2,
      rejection_reason: "Weather window is wrong.",
    });
    vi.mocked(loadProductionScheduleApproval)
      .mockResolvedValueOnce(
        detailModel(pending, [
          "production_schedule_approval.read",
          "production_schedule_approval.approve",
          "production_schedule_approval.reject",
        ]),
      )
      .mockResolvedValue(
        detailModel(denied, [
          "production_schedule_approval.read",
          "production_schedule_approval.reject",
        ]),
      );
    vi.mocked(rejectProductionScheduleApproval).mockResolvedValue({ approval: denied });
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByLabelText("Why should this request be rejected?"));
    await user.paste("Weather window is wrong.");
    await user.click(screen.getByRole("button", { name: "Reject request" }));

    await waitFor(() => {
      expect(rejectProductionScheduleApproval).toHaveBeenCalledWith(
        ownerSession,
        "production-schedule-approval:ui-001",
        1,
        "Weather window is wrong.",
        "production-schedule-approval:decision-ui-001",
      );
    });
    expect(approveProductionScheduleApproval).not.toHaveBeenCalled();
    expect(newProductionScheduleApprovalDecisionKey).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/the request was rejected. no crew assignment was created/i),
    ).toBeVisible();
    expect(screen.getAllByText("Not approved").length).toBeGreaterThan(0);
    expect(screen.getByText("Weather window is wrong.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Approve crew assignment" }),
    ).not.toBeInTheDocument();
    firstViewHidesSystemIds();
  });

  it("fails closed when an uncertain decision cannot be followed by a current read", async () => {
    const user = userEvent.setup();
    vi.mocked(loadProductionScheduleApproval)
      .mockResolvedValueOnce(
        detailModel(request(), [
          "production_schedule_approval.read",
          "production_schedule_approval.approve",
          "production_schedule_approval.reject",
        ]),
      )
      .mockRejectedValueOnce(new Error("read unavailable"));
    vi.mocked(approveProductionScheduleApproval).mockRejectedValue(
      new ApiError({
        status: 502,
        code: "execution_uncertain",
        message: "The broker result could not be verified.",
      }),
    );
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    await user.click(screen.getByRole("button", { name: "Approve crew assignment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /the result is uncertain. do not retry/i,
    );
    expect(screen.getAllByText("Refresh before another decision").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Approve crew assignment" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("turns an uncertain broker outcome into reconciliation work without a retry", async () => {
    const user = userEvent.setup();
    const uncertain = request({
      state: "execution_uncertain",
      version: 3,
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2026-07-20T12:01:00.000Z",
      },
      hermes_run_id: "run:production-schedule:ui-001",
      error_code: "broker_response_unverified",
    });
    const reconciled = {
      ...uncertain,
      version: 4,
      reconciliation: {
        at: "2026-07-20T12:02:00.000Z",
        by_user_id: "appu_owner",
        by_frappe_user: "owner@ironwrapexteriors.com",
        outcome: "inconclusive" as const,
        evidence: "The schedule service result was unavailable; no second assignment was issued.",
      },
    };
    vi.mocked(loadProductionScheduleApproval)
      .mockResolvedValueOnce(
        detailModel(uncertain, [
          "production_schedule_approval.read",
          "production_schedule_approval.reconcile",
        ]),
      )
      .mockResolvedValue(
        detailModel(reconciled, [
          "production_schedule_approval.read",
          "production_schedule_approval.reconcile",
        ]),
      );
    vi.mocked(reconcileProductionScheduleApproval).mockResolvedValue({ approval: reconciled });
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    expect(screen.getByText("Do not retry this request")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Approve crew assignment" }),
    ).not.toBeInTheDocument();
    firstViewHidesSystemIds();
    await user.click(screen.getByRole("button", { name: "Reconcile recorded outcome" }));
    await user.click(screen.getByLabelText("Reconciliation evidence"));
    await user.paste(
      "The schedule service result was unavailable; no second assignment was issued.",
    );
    await user.click(screen.getByRole("button", { name: "Record reconciliation" }));

    await waitFor(() => {
      expect(reconcileProductionScheduleApproval).toHaveBeenCalledWith(
        ownerSession,
        "production-schedule-approval:ui-001",
        3,
        "inconclusive",
        "The schedule service result was unavailable; no second assignment was issued.",
      );
    });
    expect(approveProductionScheduleApproval).not.toHaveBeenCalled();
    expect(rejectProductionScheduleApproval).not.toHaveBeenCalled();
    expect(await screen.findByText(/reconciliation recorded: inconclusive/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Reconcile recorded outcome" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the recorded authority refusal on a failed request", async () => {
    vi.mocked(loadProductionScheduleApproval).mockResolvedValue(
      detailModel(
        request({
          state: "failed",
          refusal_message: "Safety clearance is missing for this crew window.",
        }),
        ["production_schedule_approval.read"],
      ),
    );
    renderPage(<ProductionScheduleApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Crew assignment request" });
    expect(screen.getByText("Safety clearance is missing for this crew window.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Approve crew assignment" }),
    ).not.toBeInTheDocument();
  });
});
