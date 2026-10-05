import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { revisionFixture } from "../jobs/job-read-test-fixtures";
import type { ProposalPublicationApprovalRequest } from "../proposal/proposal-publication-contracts";
import { ApprovalReceipt } from "./approval-receipt";

const locale = { locale: "en-CA", timeZone: "America/Edmonton" };

function approvedRevision() {
  return {
    ...revisionFixture(),
    state: "executed" as const,
    version: 41,
    approved_by: {
      user_id: "appu_owner",
      frappe_user: "reviewer@example.invalid",
      approved_at: "2026-10-02T10:02:00.000Z",
    },
    completed_at: "2026-10-02T10:03:00.000Z",
    outcome: {
      run_id: "run:job-read-001",
      created: true as const,
      customer_quote_id: "QUOTE-READ-001-v8",
      quote_version: 8,
      supersedes: "QUOTE-READ-001",
      audit_finalized: true as const,
      customer_notified: false as const,
      commercial_terms_copied: false as const,
      proposal_sent: false as const,
      accounting_mutated: false as const,
    },
  };
}

describe("persisted approval proof", () => {
  it("does not manufacture a receipt for a pending review", () => {
    render(<ApprovalReceipt approval={revisionFixture()} locale={locale} />);
    expect(screen.queryByRole("region", { name: "Approval receipt" })).not.toBeInTheDocument();
  });

  it("attributes request, approval and saved result separately without inferring an approved request version", () => {
    render(<ApprovalReceipt approval={approvedRevision()} locale={locale} />);
    const events = within(
      screen.getByRole("list", { name: "Recorded approval events" }),
    ).getAllByRole("listitem");

    expect(events[0]).toHaveTextContent("ops@example.invalid · requested this review");
    expect(events[1]).toHaveTextContent("reviewer@example.invalid · recorded approval");
    expect(events[1]?.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-10-02T10:02:00.000Z",
    );
    expect(events[2]).toHaveTextContent("empty quote draft v8 created; audit receipt finalized");
    expect(screen.getByText("Request now").nextElementSibling).toHaveTextContent("v41");
    expect(screen.getByText("Approved snapshot version").nextElementSibling).toHaveTextContent(
      "Not provided by the saved receipt",
    );
    expect(screen.getByText(/v7 · Needs Review/)).toBeVisible();
    // A code never stands alone: the tag prints its plain kind word first.
    expect(screen.getByText("Record QUOTE-READ-001")).toBeVisible();
    expect(screen.getByText(/material release, and crew dispatch still require/)).toBeVisible();
    expect(screen.queryByText(/v39/)).not.toBeInTheDocument();
  });

  it("keeps approval and uncertain execution distinct, even after an inconclusive result check", () => {
    const approval = {
      ...approvedRevision(),
      state: "execution_uncertain" as const,
      outcome: null,
      reconciliation: {
        at: "2026-10-02T10:04:00.000Z",
        by_user_id: "appu_ops",
        by_frappe_user: "ops@example.invalid",
        outcome: "inconclusive" as const,
        evidence: "The saved run cannot establish whether a draft was created.",
      },
    };
    render(<ApprovalReceipt approval={approval} locale={locale} />);

    expect(screen.getByText("Result still needs a check")).toBeVisible();
    expect(screen.getByText(/checked the result: inconclusive/)).toBeVisible();
    expect(screen.queryByText(/audit receipt finalized/)).not.toBeInTheDocument();
    expect(screen.queryByText("Result recorded")).not.toBeInTheDocument();
  });

  it("does not borrow the approval time for an undated saved result", () => {
    render(
      <ApprovalReceipt approval={{ ...approvedRevision(), completed_at: null }} locale={locale} />,
    );
    const result = within(
      screen.getByRole("list", { name: "Recorded approval events" }),
    ).getAllByRole("listitem")[2]!;
    expect(result).toHaveTextContent("Date unavailable");
    expect(result.querySelector("time")).not.toHaveAttribute("datetime");
  });

  it("retains the exact proposal observed in the publication receipt without claiming a link was issued", () => {
    const revision = approvedRevision();
    const approval: ProposalPublicationApprovalRequest = {
      ...revision,
      id: "publication:read-001",
      kind: "proposal_publication",
      action: "publish_proposal_evidence_pack",
      proposal_evidence_pack_id: "PACK-READ-001",
      customer_quote_id: "QUOTE-READ-001",
      target: { doctype: "Proposal Evidence Pack", proposal_evidence_pack_id: "PACK-READ-001" },
      pack_status_before: "Draft",
      preview: {
        would_write: false,
        target: { doctype: "Proposal Evidence Pack", proposal_evidence_pack_id: "PACK-READ-001" },
        before: {
          proposal_evidence_pack_id: "PACK-READ-001",
          roof_job: "JOB-READ-001",
          quotation: "QUOTE-READ-001",
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
      outcome: {
        run_id: revision.run_id,
        published: true,
        proposal_evidence_pack_id: "PACK-READ-001",
        customer_quote_id: "QUOTE-READ-001",
        status: "Approved",
        audit_finalized: true,
        customer_portal_link_issued: false,
        customer_delivery_mutated: false,
        contract_acceptance_mutated: false,
        customer_quote_mutated: false,
      },
    };
    render(<ApprovalReceipt approval={approval} locale={locale} />);
    expect(screen.getByText("Record PACK-READ-001")).toBeVisible();
    expect(screen.getByText("Draft · quote QUOTE-READ-001")).toBeVisible();
    expect(screen.getByText(/already-issued customer link/)).toBeVisible();
    expect(screen.getByText(/recording customer acceptance remain separate/)).toBeVisible();
  });
});
