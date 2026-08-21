import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
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
    vi.mocked(newProductionScheduleApprovalDecisionKey).mockReturnValue(
      "production-schedule-approval:decision-ui-001",
    );
  });

  it("lists prepared schedule requests without exposing broker internals", async () => {
    const { container } = renderPage(<ProductionScheduleApprovalQueuePage />);

    await screen.findByRole("heading", { name: "Schedule request queue" });
    expect(screen.getByText("Job JOB-001")).toBeVisible();
    expect(screen.getByText("Crew crew:metal-1")).toBeVisible();
    expect(screen.getByText(/does not notify the crew/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /job job-001 crew crew:metal-1/i })).toHaveAttribute(
      "href",
      "/production/schedule-approvals/production-schedule-approval:ui-001",
    );
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
    expect(await screen.findByText(/job assignment and hermes run are recorded/i)).toBeVisible();
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

    expect(await screen.findByText(/the result is uncertain. do not retry/i)).toBeVisible();
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
        evidence: "The Hermes Run was unavailable; no second assignment was issued.",
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
    await user.click(screen.getByRole("button", { name: "Reconcile recorded outcome" }));
    await user.type(
      screen.getByLabelText("Reconciliation evidence"),
      "The Hermes Run was unavailable; no second assignment was issued.",
    );
    await user.click(screen.getByRole("button", { name: "Record reconciliation" }));

    await waitFor(() => {
      expect(reconcileProductionScheduleApproval).toHaveBeenCalledWith(
        ownerSession,
        "production-schedule-approval:ui-001",
        3,
        "inconclusive",
        "The Hermes Run was unavailable; no second assignment was issued.",
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
