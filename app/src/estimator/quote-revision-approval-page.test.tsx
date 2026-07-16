import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadEstimatorWorkbench } from "./estimator-api";
import type { EstimatorWorkbenchResponse } from "./estimator-contracts";
import {
  approveQuoteRevisionApproval,
  loadQuoteRevisionApproval,
  loadQuoteRevisionApprovals,
  newQuoteRevisionApprovalDecisionKey,
  newQuoteRevisionApprovalPrepareKey,
  prepareQuoteRevisionApproval,
  reconcileQuoteRevisionApproval,
  rejectQuoteRevisionApproval,
} from "./quote-revision-approval-api";
import type {
  QuoteRevisionApprovalDetailResponse,
  QuoteRevisionApprovalListResponse,
  QuoteRevisionApprovalRequest,
} from "./quote-revision-approval-contracts";
import {
  QuoteRevisionApprovalDetailPage,
  QuoteRevisionApprovalPreparePage,
  QuoteRevisionApprovalQueuePage,
} from "./quote-revision-approval-page";

const router = vi.hoisted(() => ({
  params: {} as { jobId?: string; approvalId?: string },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => router.params,
  useNavigate: () => router.navigate,
}));
vi.mock("./estimator-api", () => ({ loadEstimatorWorkbench: vi.fn() }));
vi.mock("./quote-revision-approval-api", () => ({
  approveQuoteRevisionApproval: vi.fn(),
  loadQuoteRevisionApproval: vi.fn(),
  loadQuoteRevisionApprovals: vi.fn(),
  newQuoteRevisionApprovalDecisionKey: vi.fn(),
  newQuoteRevisionApprovalPrepareKey: vi.fn(),
  prepareQuoteRevisionApproval: vi.fn(),
  reconcileQuoteRevisionApproval: vi.fn(),
  rejectQuoteRevisionApproval: vi.fn(),
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
  permissions: ["estimator:read"],
  allowed_actions: ["quote_revision_approval.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-12T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function request(
  overrides: Partial<QuoteRevisionApprovalRequest> = {},
): QuoteRevisionApprovalRequest {
  return {
    id: "quote-revision-approval:ui-001",
    kind: "quote_revision",
    state: "pending",
    version: 1,
    action: "create_quote_revision_draft",
    roof_job_id: "JOB-A",
    source: {
      customer_quote_id: "QUOTE-A",
      quote_version: 3,
      status: "Needs Review",
      modified: "2026-07-12T12:00:00.000Z",
    },
    target: {
      doctype: "Customer Quote",
      customer_quote_id: "QUOTE-A-V4",
      quote_version: 4,
    },
    correction_reason:
      "Correct the verified measurement source before entering a new commercial version.",
    request_text: "Prepare a blank Draft shell after human review.",
    preview: {
      would_write: false,
      append_only: true,
      target: {
        doctype: "Customer Quote",
        customer_quote_id: "QUOTE-A-V4",
        quote_version: 4,
      },
      source: {
        customer_quote_id: "QUOTE-A",
        quote_version: 3,
        status: "Needs Review",
        modified: "2026-07-12T12:00:00.000Z",
      },
      draft: {
        customer_quote_id: "QUOTE-A-V4",
        quote_version: 4,
        status: "Draft",
        supersedes: "QUOTE-A",
        correction_reason:
          "Correct the verified measurement source before entering a new commercial version.",
      },
      observed_quote_count: 1,
      effects: {
        customer_notified: false,
        commercial_terms_copied: false,
        proposal_sent: false,
        accounting_mutated: false,
      },
    },
    expires_at: "2026-07-12T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:quote-revision:ui-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function listModel(
  approval = request(),
  allowedActions = ["quote_revision_approval.read"],
): QuoteRevisionApprovalListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-12T12:00:00.000Z",
    permissions: ["estimator:read"],
    allowed_actions: allowedActions as QuoteRevisionApprovalListResponse["allowed_actions"],
    approvals: [approval],
  };
}

function detailModel(
  approval = request(),
  allowedActions = ["quote_revision_approval.read"],
): QuoteRevisionApprovalDetailResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-12T12:00:00.000Z",
    permissions: ["estimator:read"],
    allowed_actions: allowedActions as QuoteRevisionApprovalDetailResponse["allowed_actions"],
    approval,
  };
}

function workbench(): EstimatorWorkbenchResponse {
  return {
    job: { id: "JOB-A" },
    quote: { id: "QUOTE-A", version: 3, status: "Needs Review" },
    allowed_actions: ["estimator.read", "quote_revision_approval.prepare"],
  } as EstimatorWorkbenchResponse;
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

describe("QuoteRevisionApprovalPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.params = { jobId: "JOB-A", approvalId: "quote-revision-approval:ui-001" };
    vi.mocked(loadQuoteRevisionApprovals).mockResolvedValue(listModel());
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(detailModel());
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbench());
    vi.mocked(newQuoteRevisionApprovalPrepareKey).mockReturnValue(
      "quote-revision-approval:prepare-ui-001",
    );
    vi.mocked(newQuoteRevisionApprovalDecisionKey).mockReturnValue(
      "quote-revision-approval:decision-ui-001",
    );
  });

  it("keeps the dedicated queue on the bounded source-to-blank-Draft decision", async () => {
    const { container } = renderPage(<QuoteRevisionApprovalQueuePage />);

    await screen.findByRole("heading", { name: "Draft revision queue" });
    expect(screen.getByText("Source V3")).toBeVisible();
    expect(screen.getByText("Blank Draft V4")).toBeVisible();
    expect(screen.getByText(/no pricing, tax, scope, payment/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /source v3 blank draft v4/i })).toHaveAttribute(
      "href",
      "/quote-revision-approvals/$approvalId",
    );
    expect(container.textContent).not.toMatch(/dry_run_receipt|write_args_json|quote_total/i);
  });

  it("submits only the source identity and correction reason, then opens its recorded decision", async () => {
    const user = userEvent.setup();
    const prepared = request();
    vi.mocked(prepareQuoteRevisionApproval).mockResolvedValue({ approval: prepared });
    router.params = { jobId: "JOB-A" };
    renderPage(<QuoteRevisionApprovalPreparePage />);

    await screen.findByRole("heading", { name: "Draft quote revision" });
    await user.type(
      screen.getByLabelText("Correction reason"),
      "Correct the verified source before the next commercial review.",
    );
    await user.click(screen.getByRole("button", { name: "Prepare draft revision" }));

    await waitFor(() => {
      expect(prepareQuoteRevisionApproval).toHaveBeenCalledWith(
        ownerSession,
        {
          roofJobId: "JOB-A",
          customerQuoteId: "QUOTE-A",
          correctionReason: "Correct the verified source before the next commercial review.",
        },
        "quote-revision-approval:prepare-ui-001",
      );
    });
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/quote-revision-approvals/$approvalId",
      params: { approvalId: "quote-revision-approval:ui-001" },
    });
  });

  it("does not infer approval authority from the role when the server omits the decision action", async () => {
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
      detailModel(request(), ["quote_revision_approval.read"]),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Blank Draft revision" });
    expect(screen.queryByRole("button", { name: "Approve Draft shell" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the designated approver/i)).toBeVisible();
  });

  it("fails closed when an uncertain decision cannot be followed by a current read", async () => {
    const user = userEvent.setup();
    vi.mocked(loadQuoteRevisionApproval)
      .mockResolvedValueOnce(
        detailModel(request(), [
          "quote_revision_approval.read",
          "quote_revision_approval.approve",
          "quote_revision_approval.reject",
        ]),
      )
      .mockRejectedValueOnce(new Error("read unavailable"));
    vi.mocked(approveQuoteRevisionApproval).mockRejectedValue(
      new ApiError({
        status: 502,
        code: "execution_uncertain",
        message: "The broker result could not be verified.",
      }),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Blank Draft revision" });
    await user.click(screen.getByRole("button", { name: "Approve Draft shell" }));

    expect(await screen.findByText(/the result is uncertain. do not retry/i)).toBeVisible();
    expect(await screen.findByText("Refresh before another decision")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve Draft shell" })).not.toBeInTheDocument();
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
        approved_at: "2026-07-12T12:01:00.000Z",
      },
      hermes_run_id: "run:quote-revision:ui-001",
      error_code: "broker_response_unverified",
    });
    const reconciled = {
      ...uncertain,
      version: 4,
      reconciliation: {
        at: "2026-07-12T12:02:00.000Z",
        by_user_id: "appu_owner",
        by_frappe_user: "owner@ironwrapexteriors.com",
        outcome: "inconclusive" as const,
        evidence: "The Hermes Run was unavailable; no second Draft shell was issued.",
      },
    };
    vi.mocked(loadQuoteRevisionApproval)
      .mockResolvedValueOnce(
        detailModel(uncertain, [
          "quote_revision_approval.read",
          "quote_revision_approval.reconcile",
        ]),
      )
      .mockResolvedValue(
        detailModel(reconciled, [
          "quote_revision_approval.read",
          "quote_revision_approval.reconcile",
        ]),
      );
    vi.mocked(reconcileQuoteRevisionApproval).mockResolvedValue({ approval: reconciled });
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Blank Draft revision" });
    expect(screen.getByText("Do not retry this request")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve Draft shell" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconcile recorded outcome" }));
    await user.type(
      screen.getByLabelText("Reconciliation evidence"),
      "The Hermes Run was unavailable; no second Draft shell was issued.",
    );
    await user.click(screen.getByRole("button", { name: "Record reconciliation" }));

    await waitFor(() => {
      expect(reconcileQuoteRevisionApproval).toHaveBeenCalledWith(
        ownerSession,
        "quote-revision-approval:ui-001",
        3,
        "inconclusive",
        "The Hermes Run was unavailable; no second Draft shell was issued.",
      );
    });
    expect(approveQuoteRevisionApproval).not.toHaveBeenCalled();
    expect(rejectQuoteRevisionApproval).not.toHaveBeenCalled();
    expect(await screen.findByText(/reconciliation recorded: inconclusive/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Reconcile recorded outcome" }),
    ).not.toBeInTheDocument();
  });
});
