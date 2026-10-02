import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import {
  approveApproval,
  loadApprovals,
  loadApproval,
  newApprovalDecisionKey,
  reconcileApproval,
  rejectApproval,
} from "./approval-api";
import type { ApprovalListResponse, ApprovalRequest } from "./approval-contracts";
import { ApprovalInboxPage } from "./approval-inbox-page";

vi.mock("./approval-api", () => ({
  loadApprovals: vi.fn(),
  loadApproval: vi.fn(),
  approveApproval: vi.fn(),
  reconcileApproval: vi.fn(),
  rejectApproval: vi.fn(),
  newApprovalDecisionKey: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/owner">{children}</a>,
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
  permissions: ["approvals:read"],
  allowed_actions: ["approval.approve", "approval.reject"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-11T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function pendingApproval(): ApprovalRequest {
  return {
    id: "approval:ui-001",
    kind: "lead_triage",
    state: "pending",
    version: 1,
    action: "mark_lead_triaged",
    target: { doctype: "Lead Envelope", name: "lead:ui-001", lead_envelope_id: "lead:ui-001" },
    request_text: "Record local triage only after owner review.",
    preview: {
      would_write: false,
      target: { doctype: "Lead Envelope", name: "lead:ui-001" },
      before: {
        triage_status: "Untriaged",
        triaged_by: null,
        triaged_at: null,
        triage_summary: null,
      },
      patch: {
        triage_status: "Triaged",
        triaged_by: "owner@ironwrapexteriors.com",
        triaged_at: null,
        triage_summary: "Hail report; confirm inspection window before outreach.",
      },
      transport_status_unchanged: "pushed",
      communication_events_mutated: false,
    },
    expires_at: "2026-07-11T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:lead-triage:ui-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2026-07-11T12:00:00.000Z",
    updated_at: "2026-07-11T12:00:00.000Z",
    completed_at: null,
  };
}

function executedApproval(): ApprovalRequest {
  const pending = pendingApproval();
  return {
    ...pending,
    state: "executed",
    version: 3,
    approved_by: {
      user_id: "appu_owner",
      frappe_user: "owner@ironwrapexteriors.com",
      approved_at: "2026-07-11T12:01:00.000Z",
    },
    hermes_run_id: "run:lead-triage:ui-001",
    outcome: {
      run_id: "run:lead-triage:ui-001",
      lead_envelope_id: "lead:ui-001",
      updated: true,
      audit_finalized: true,
      replayed: false,
      communication_events_mutated: false,
    },
    updated_at: "2026-07-11T12:01:00.000Z",
    completed_at: "2026-07-11T12:01:00.000Z",
  };
}

function uncertainApproval(): ApprovalRequest {
  const pending = pendingApproval();
  return {
    ...pending,
    state: "execution_uncertain",
    version: 3,
    approved_by: {
      user_id: "appu_owner",
      frappe_user: "owner@ironwrapexteriors.com",
      approved_at: "2026-07-11T12:01:00.000Z",
    },
    hermes_run_id: "run:lead-triage:ui-001",
    error_code: "broker_response_unverified",
    updated_at: "2026-07-11T12:01:00.000Z",
    completed_at: "2026-07-11T12:01:00.000Z",
  };
}

function reconciledUncertainApproval(): ApprovalRequest {
  const uncertain = uncertainApproval();
  return {
    ...uncertain,
    version: 4,
    reconciliation: {
      at: "2026-07-11T12:02:00.000Z",
      by_user_id: "appu_owner",
      by_frappe_user: "owner@ironwrapexteriors.com",
      outcome: "inconclusive",
      evidence: "The recorded Hermes Run was unavailable; no second write was issued.",
    },
  };
}

function model(
  approval: ApprovalRequest = pendingApproval(),
  allowedActions = ["approval.read", "approval.approve", "approval.reject"],
): ApprovalListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-11T12:00:00.000Z",
    permissions: ["approvals:read"],
    allowed_actions: allowedActions,
    approvals: [approval],
  };
}

function renderInbox({
  session = ownerSession,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  reviewId,
}: {
  session?: AuthenticatedSession;
  client?: QueryClient;
  reviewId?: string;
} = {}) {
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <ApprovalInboxPage reviewId={reviewId} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("ApprovalInboxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadApprovals).mockResolvedValue(model());
    vi.mocked(newApprovalDecisionKey).mockReturnValue("approval:stable-ui-decision-001");
    vi.mocked(rejectApproval).mockResolvedValue({ approval: pendingApproval() });
    vi.mocked(reconcileApproval).mockResolvedValue({ approval: reconciledUncertainApproval() });
  });

  it("opens the exact linked review without depending on the first page of lead history", async () => {
    vi.mocked(loadApproval).mockResolvedValue(model());
    renderInbox({ reviewId: "approval:ui-001" });
    await screen.findByRole("heading", { name: "Review lead note" });
    expect(loadApproval).toHaveBeenCalledWith("approval:ui-001");
    expect(loadApprovals).not.toHaveBeenCalled();
    expect(screen.getByText("What will change")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to decisions" })).toHaveAttribute(
      "href",
      "/now?show=decide",
    );
  });

  it("requires a fresh native read after a failed refresh and after an uncertain mutation", async () => {
    const user = userEvent.setup();
    vi.mocked(loadApproval).mockResolvedValueOnce(model()).mockRejectedValue(new Error("offline"));
    vi.mocked(approveApproval).mockRejectedValue(new Error("response lost"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["now", ownerSession.tenant.id, ownerSession.user.id], { prior: true });
    renderInbox({ reviewId: "approval:ui-001", client });
    await screen.findByRole("button", { name: "Save lead check" });
    await user.click(screen.getByRole("button", { name: "Load again" }));
    await screen.findByText("This may be an old list");
    expect(screen.queryByRole("button", { name: "Save lead check" })).not.toBeInTheDocument();
    expect(approveApproval).not.toHaveBeenCalled();

    vi.mocked(loadApproval)
      .mockResolvedValueOnce(model())
      .mockRejectedValue(new Error("still offline"));
    await user.click(screen.getByRole("button", { name: "Load again" }));
    await user.click(await screen.findByRole("button", { name: "Save lead check" }));
    await screen.findByText("Check the saved state");
    await screen.findByText("This may be an old list");
    expect(screen.queryByRole("button", { name: "Save lead check" })).not.toBeInTheDocument();
    expect(approveApproval).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryState(["now", ownerSession.tenant.id, ownerSession.user.id])?.isInvalidated,
    ).toBe(true);
  });

  it("keeps a linked lead review read-only in an offline session", async () => {
    vi.mocked(loadApproval).mockResolvedValue(model());
    renderInbox({
      reviewId: "approval:ui-001",
      session: { ...ownerSession, csrf_token: "offline-session-no-csrf" },
    });
    await screen.findByText("Go online before you choose");
    expect(screen.getByText("What will change")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save lead check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
    expect(approveApproval).not.toHaveBeenCalled();
    expect(rejectApproval).not.toHaveBeenCalled();
  });

  it("shows an exact, bounded local-triage review and carries a stable CAS decision through the API", async () => {
    const user = userEvent.setup();
    const executed = executedApproval();
    vi.mocked(loadApprovals).mockResolvedValueOnce(model()).mockResolvedValue(model(executed));
    vi.mocked(approveApproval).mockResolvedValue({ approval: executed });
    const { container } = renderInbox();

    await screen.findByRole("heading", { name: "Lead reviews" });
    await user.click(screen.getByLabelText(/Review lead check:/i));
    expect(screen.getByText("What will change")).toBeVisible();
    expect(
      screen.getByText(
        "No customer message. Lead delivery stays the same. Quotes and money records do not change.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save lead check" })).toBeVisible();
    expect(container.textContent).not.toMatch(/dry_run_receipt|approval_receipt|write_args_json/i);
    expect(container.textContent).not.toMatch(/sent|delivered|contacted customer/i);

    await user.click(screen.getByRole("button", { name: "Save lead check" }));

    await waitFor(() => {
      expect(approveApproval).toHaveBeenCalledWith(
        ownerSession,
        "approval:ui-001",
        1,
        "approval:stable-ui-decision-001",
      );
    });
    expect(rejectApproval).not.toHaveBeenCalled();
    expect((await screen.findAllByText("Lead check saved")).length).toBeGreaterThan(0);
    expect(screen.getByText("run:lead-triage:ui-001")).not.toBeVisible();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("run:lead-triage:ui-001")).toBeVisible();
  });

  it("keeps every live review visible while collapsing terminal history", async () => {
    const settled = Array.from({ length: 5 }, (_, index) => {
      const approval = executedApproval();
      return {
        ...approval,
        id: `approval:history-${index}`,
        request_text: `History ${index + 1}`,
        preview: approval.preview
          ? {
              ...approval.preview,
              patch: {
                ...approval.preview.patch,
                triage_summary: `History ${index + 1}`,
              },
            }
          : null,
      } satisfies ApprovalRequest;
    });
    const pending = pendingApproval();
    pending.id = "approval:pending-visible";
    pending.preview!.patch.triage_summary = "Needs a decision now";
    vi.mocked(loadApprovals).mockResolvedValueOnce({
      ...model(),
      approvals: [...settled, pending],
    });
    renderInbox();

    expect(await screen.findByLabelText(/History 3/i)).toBeVisible();
    expect(screen.queryByLabelText(/History 4/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Needs a decision now/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByLabelText(/History 5/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps operations review-only when the server omits decision capabilities", async () => {
    const opsSession = {
      ...ownerSession,
      user: { ...ownerSession.user, role: "ops" as const },
    };
    vi.mocked(loadApprovals).mockResolvedValueOnce(model(pendingApproval(), ["approval.read"]));
    renderInbox({ session: opsSession });

    await screen.findByRole("heading", { name: "Lead reviews" });
    await userEvent.click(screen.getByLabelText(/Review lead check:/i));
    expect(screen.queryByRole("button", { name: "Save lead check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for the right owner/i)).toBeVisible();
  });

  it("turns ambiguity into explicit manual reconciliation work without an automatic retry control", async () => {
    vi.mocked(loadApprovals).mockResolvedValueOnce(model(uncertainApproval()));
    renderInbox();

    await screen.findByRole("heading", { name: "Lead reviews" });
    await userEvent.click(screen.getByLabelText(/Review lead check:/i));
    expect(screen.getByText("Do not try this request again")).toBeVisible();
    expect(screen.getByText(/check the save record before you do anything else/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save lead check" })).not.toBeInTheDocument();
  });

  it("records reconciliation evidence without reopening or repeating the protected write", async () => {
    const user = userEvent.setup();
    const reconciled = reconciledUncertainApproval();
    vi.mocked(loadApprovals)
      .mockResolvedValueOnce(model(uncertainApproval(), ["approval.read", "approval.reconcile"]))
      .mockResolvedValue(model(reconciled, ["approval.read", "approval.reconcile"]));
    vi.mocked(reconcileApproval).mockResolvedValue({ approval: reconciled });
    renderInbox();

    await screen.findByRole("heading", { name: "Lead reviews" });
    await user.click(screen.getByLabelText(/Review lead check:/i));
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    await user.type(
      screen.getByLabelText("What did you check?"),
      "The recorded Hermes Run was unavailable; no second write was issued.",
    );
    await user.click(screen.getByRole("button", { name: "Save result check" }));

    await waitFor(() => {
      expect(reconcileApproval).toHaveBeenCalledWith(
        ownerSession,
        "approval:ui-001",
        3,
        "inconclusive",
        "The recorded Hermes Run was unavailable; no second write was issued.",
      );
    });
    expect(approveApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/Result check saved: Not sure/i)).toBeVisible();
  });
});
