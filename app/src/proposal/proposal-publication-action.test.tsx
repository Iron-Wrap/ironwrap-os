import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import {
  approveProposalPublication,
  loadProposalPublicationApprovals,
  prepareProposalPublication,
  rejectProposalPublication,
} from "./proposal-publication-api";
import { ProposalPublicationAction } from "./proposal-publication-action";
import type { ProposalPublicationApprovalRequest } from "./proposal-publication-contracts";

vi.mock("./proposal-publication-api", async () => {
  const actual = await vi.importActual<typeof import("./proposal-publication-api")>(
    "./proposal-publication-api",
  );
  return {
    ...actual,
    approveProposalPublication: vi.fn(),
    loadProposalPublicationApprovals: vi.fn(),
    prepareProposalPublication: vi.fn(),
    rejectProposalPublication: vi.fn(),
  };
});

const ROOF_JOB = "JOB-A";
const CUSTOMER_QUOTE = "customer-quote:JOB-A-v1";
const PACK = `proposal:${CUSTOMER_QUOTE}`;

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
    name: "IronWrap OS",
    brand: "IronWrap",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-01-01T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2030-01-01T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function approval(
  overrides: Partial<ProposalPublicationApprovalRequest> = {},
): ProposalPublicationApprovalRequest {
  return {
    id: "proposal-publication-approval:abcdefghijklmnop",
    kind: "proposal_publication",
    state: "pending",
    version: 1,
    action: "publish_proposal_evidence_pack",
    roof_job_id: ROOF_JOB,
    proposal_evidence_pack_id: PACK,
    customer_quote_id: CUSTOMER_QUOTE,
    target: { doctype: "Proposal Evidence Pack", proposal_evidence_pack_id: PACK },
    pack_status_before: "Draft",
    request_text: "Publish the reviewed Draft proposal to the private customer portal.",
    preview: {
      would_write: false,
      target: { doctype: "Proposal Evidence Pack", proposal_evidence_pack_id: PACK },
      before: {
        proposal_evidence_pack_id: PACK,
        roof_job: ROOF_JOB,
        quotation: CUSTOMER_QUOTE,
        status: "Draft",
      },
      publication: { status: "Approved" },
      customer_portal: {
        visible_after_publication: true,
        portal_link_issued: false,
        human_portal_link_issuance_required: true,
      },
      effects: {
        customer_delivery_mutated: false,
        contract_acceptance_mutated: false,
        customer_quote_mutated: false,
      },
    },
    expires_at: "2030-01-01T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:proposal-publication:abcdefgh",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2030-01-01T12:00:00.000Z",
    updated_at: "2030-01-01T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function listResponse(
  approvals: ProposalPublicationApprovalRequest[],
  allowed: string[] = [
    "proposal_publication_approval.read",
    "proposal_publication_approval.prepare",
    "proposal_publication_approval.approve",
  ],
) {
  return {
    version: 1 as const,
    read_model_generated_at: "2030-01-01T12:00:00.000Z",
    permissions: ["jobs:read:any"],
    allowed_actions: allowed as never,
    approvals,
  };
}

function renderAction(
  proposalEvidencePackId: string | null = PACK,
  proposalStatus: string | null = "Draft",
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={ownerSession}>
        <ProposalPublicationAction
          roofJobId={ROOF_JOB}
          proposalEvidencePackId={proposalEvidencePackId}
          proposalStatus={proposalStatus}
          locale="en-CA"
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("ProposalPublicationAction", () => {
  it("takes the owner from a Draft pack to a live customer proposal in two deliberate steps", async () => {
    const prepared = approval();
    vi.mocked(loadProposalPublicationApprovals)
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValue(listResponse([prepared]));
    vi.mocked(prepareProposalPublication).mockResolvedValue({ approval: prepared });

    renderAction();

    const prepare = await screen.findByRole("button", { name: /prepare publication/i });
    fireEvent.click(prepare);

    // The confirmation states exactly what publication does and does not do,
    // so the owner is never guessing what the customer is about to receive.
    await screen.findByText(/confirm what the customer will see/i);
    expect(screen.getByText("Draft → Approved")).toBeTruthy();
    expect(screen.getByText(CUSTOMER_QUOTE)).toBeTruthy();
    expect(screen.getAllByText("No").length).toBe(3);
    expect(vi.mocked(prepareProposalPublication).mock.calls[0]?.[1]).toEqual({
      roofJobId: ROOF_JOB,
      proposalEvidencePackId: PACK,
    });

    const published = approval({
      state: "executed",
      version: 3,
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2030-01-01T12:01:00.000Z",
      },
      hermes_run_id: "run:proposal-publication:abcdefgh",
      outcome: {
        run_id: "run:proposal-publication:abcdefgh",
        published: true,
        proposal_evidence_pack_id: PACK,
        customer_quote_id: CUSTOMER_QUOTE,
        status: "Approved",
        audit_finalized: true,
        customer_portal_link_issued: false,
        customer_delivery_mutated: false,
        contract_acceptance_mutated: false,
        customer_quote_mutated: false,
      },
      completed_at: "2030-01-01T12:01:00.000Z",
    });
    vi.mocked(approveProposalPublication).mockResolvedValue({ approval: published });
    vi.mocked(loadProposalPublicationApprovals).mockResolvedValue(listResponse([published]));

    fireEvent.click(screen.getByRole("button", { name: /publish to customer portal/i }));

    await screen.findByText(/the proposal is live on the customer link/i);
    // The confirmed version is what the server was asked to act on: a stale tap
    // must not be able to publish a request the owner never saw.
    expect(vi.mocked(approveProposalPublication).mock.calls[0]?.[2]).toBe(1);
    expect(vi.mocked(rejectProposalPublication)).not.toHaveBeenCalled();
  });

  it("offers publication only for a Draft pack that exists", async () => {
    vi.mocked(loadProposalPublicationApprovals).mockResolvedValue(listResponse([]));

    const { unmount } = renderAction(null, null);
    await screen.findByText(/no proposal evidence pack links to this quote/i);
    expect(screen.queryByRole("button", { name: /prepare publication/i })).toBeNull();
    unmount();

    renderAction(PACK, "Approved");
    await screen.findByText(/this proposal is approved/i);
    expect(screen.queryByRole("button", { name: /prepare publication/i })).toBeNull();
    expect(vi.mocked(prepareProposalPublication)).not.toHaveBeenCalled();
  });

  it("cancels a prepared publication without publishing anything", async () => {
    const prepared = approval();
    vi.mocked(loadProposalPublicationApprovals).mockResolvedValue(listResponse([prepared]));
    vi.mocked(rejectProposalPublication).mockResolvedValue({
      approval: approval({ state: "denied", version: 2 }),
    });

    renderAction();
    await screen.findByText(/confirm what the customer will see/i);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(vi.mocked(rejectProposalPublication)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(approveProposalPublication)).not.toHaveBeenCalled();
  });

  it("keeps an unresolved publication attempt as reconciliation work, not a retry", async () => {
    vi.mocked(loadProposalPublicationApprovals).mockResolvedValue(
      listResponse([
        approval({
          state: "execution_uncertain",
          version: 3,
          error_code: "broker_response_timeout",
        }),
      ]),
    );

    renderAction();

    await screen.findByText(/a publication attempt is unresolved/i);
    expect(screen.getByText(/do not publish a second time/i)).toBeTruthy();
  });
});
