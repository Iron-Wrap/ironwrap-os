import { describe, expect, it } from "vitest";

import {
  quoteRevisionApprovalListResponseSchema,
  quoteRevisionApprovalRequestSchema,
} from "./quote-revision-approval-contracts";

function approvalPayload() {
  return {
    id: "quote-revision-approval:test-001",
    kind: "quote_revision",
    state: "pending",
    version: 1,
    action: "create_quote_revision_draft",
    roof_job_id: "ROOF-JOB-001",
    source: {
      customer_quote_id: "CUSTOMER-QUOTE-001",
      quote_version: 1,
      status: "Needs Review",
      modified: "2026-07-12T12:00:00.000Z",
    },
    target: {
      doctype: "Customer Quote",
      customer_quote_id: "CUSTOMER-QUOTE-001-v2",
      quote_version: 2,
    },
    correction_reason: "Correct the measurement source before new commercial terms are entered.",
    request_text:
      "Prepare an append-only Draft Customer Quote revision shell after human review. Reason: Correct the measurement source before new commercial terms are entered.",
    preview: {
      would_write: false,
      append_only: true,
      target: {
        doctype: "Customer Quote",
        customer_quote_id: "CUSTOMER-QUOTE-001-v2",
        quote_version: 2,
      },
      source: {
        customer_quote_id: "CUSTOMER-QUOTE-001",
        quote_version: 1,
        status: "Needs Review",
        modified: "2026-07-12T12:00:00.000Z",
      },
      draft: {
        customer_quote_id: "CUSTOMER-QUOTE-001-v2",
        quote_version: 2,
        status: "Draft",
        supersedes: "CUSTOMER-QUOTE-001",
        correction_reason:
          "Correct the measurement source before new commercial terms are entered.",
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
    requested_by: { user_id: "appu_ops", frappe_user: "ops@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:quote-revision:test-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
    completed_at: null,
  };
}

describe("quote revision approval browser contract", () => {
  it("accepts only the bounded draft-shell review DTO", () => {
    const payload = {
      version: 1,
      read_model_generated_at: "2026-07-12T12:00:00.000Z",
      permissions: ["estimator.read"],
      allowed_actions: ["quote_revision_approval.read", "quote_revision_approval.prepare"],
      approvals: [approvalPayload()],
    };

    expect(quoteRevisionApprovalListResponseSchema.parse(payload)).toEqual(payload);
  });

  it("fails closed if broker proof, raw write arguments, or commercial terms cross the browser boundary", () => {
    const rawReceipt = { ...approvalPayload(), dry_run_receipt: "must-never-reach-the-browser" };
    expect(quoteRevisionApprovalRequestSchema.safeParse(rawReceipt).success).toBe(false);

    const rawArgs = { ...approvalPayload(), write_args_json: '{"tax_amount":999}' };
    expect(quoteRevisionApprovalRequestSchema.safeParse(rawArgs).success).toBe(false);

    const commercialPreview = approvalPayload();
    commercialPreview.preview = {
      ...commercialPreview.preview!,
      source: { ...commercialPreview.preview!.source, quote_total: 19_500 },
    } as typeof commercialPreview.preview;
    expect(quoteRevisionApprovalRequestSchema.safeParse(commercialPreview).success).toBe(false);

    const pendingApproval = approvalPayload();
    const brokerOutcome = {
      ...pendingApproval,
      outcome: {
        run_id: pendingApproval.run_id,
        created: true,
        customer_quote_id: pendingApproval.target.customer_quote_id,
        quote_version: pendingApproval.target.quote_version,
        supersedes: pendingApproval.source.customer_quote_id,
        audit_finalized: true,
        customer_notified: false,
        commercial_terms_copied: false,
        proposal_sent: false,
        accounting_mutated: false,
        raw_broker_output: "never render this",
      },
    };
    expect(quoteRevisionApprovalRequestSchema.safeParse(brokerOutcome).success).toBe(false);
  });

  it("rejects a preview or execution result that is not bound to the displayed request", () => {
    const mismatchedPreview = approvalPayload();
    mismatchedPreview.preview = {
      ...mismatchedPreview.preview!,
      draft: {
        ...mismatchedPreview.preview!.draft,
        supersedes: "CUSTOMER-QUOTE-OTHER",
      },
    };
    expect(quoteRevisionApprovalRequestSchema.safeParse(mismatchedPreview).success).toBe(false);

    const pendingOutcome = approvalPayload();
    const mismatchedOutcome = {
      ...pendingOutcome,
      outcome: {
        run_id: pendingOutcome.run_id,
        created: true,
        customer_quote_id: pendingOutcome.target.customer_quote_id,
        quote_version: pendingOutcome.target.quote_version,
        supersedes: "CUSTOMER-QUOTE-OTHER",
        audit_finalized: true,
        customer_notified: false,
        commercial_terms_copied: false,
        proposal_sent: false,
        accounting_mutated: false,
      },
    };
    expect(quoteRevisionApprovalRequestSchema.safeParse(mismatchedOutcome).success).toBe(false);
  });
});
