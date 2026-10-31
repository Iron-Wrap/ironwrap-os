import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
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

const session = {
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
  permissions: ["estimator.read"],
  allowed_actions: ["quote_revision_approval.read", "quote_revision_approval.prepare"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-12T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function approval() {
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
    preview: null,
    expires_at: "2026-07-12T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
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

const envelope = () => ({
  version: 1,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  permissions: ["estimator.read"],
  allowed_actions: ["quote_revision_approval.read"],
});

describe("quote revision approval API", () => {
  it("loads only the dedicated same-origin approval collection and detail", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...envelope(), approvals: [approval()] }))
      .mockResolvedValueOnce(Response.json({ ...envelope(), approval: approval() }));

    const list = await loadQuoteRevisionApprovals(fetcher);
    const detail = await loadQuoteRevisionApproval("quote-revision-approval:test-001", fetcher);

    expect(list.approvals[0]?.target.customer_quote_id).toBe("CUSTOMER-QUOTE-001-v2");
    expect(detail.approval.id).toBe("quote-revision-approval:test-001");
    expect(detail.job).toBeNull();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/quote-revision-approvals");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/v1/quote-revision-approvals/quote-revision-approval%3Atest-001?include_job_identity=1",
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
  });

  it("uses the fixed draft-shell command bodies with CSRF and caller-stable idempotency", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ approval: approval() }));

    await prepareQuoteRevisionApproval(
      session,
      {
        roofJobId: "ROOF-JOB-001",
        customerQuoteId: "CUSTOMER-QUOTE-001",
        correctionReason: "Correct the measurement source before new commercial terms are entered.",
      },
      "quote-revision-approval:prepare-test-001",
      fetcher,
    );
    await approveQuoteRevisionApproval(
      session,
      "quote-revision-approval:test-001",
      1,
      "quote-revision-approval:approve-test-001",
      fetcher,
    );
    await rejectQuoteRevisionApproval(
      session,
      "quote-revision-approval:test-001",
      2,
      "Need a verified measurement source.",
      "quote-revision-approval:reject-test-001",
      fetcher,
    );
    await reconcileQuoteRevisionApproval(
      session,
      "quote-revision-approval:test-001",
      3,
      "inconclusive",
      "The Hermes Run record was unavailable; no second revision was issued.",
      fetcher,
    );

    const prepareCall = fetcher.mock.calls[0];
    const approveCall = fetcher.mock.calls[1];
    const rejectCall = fetcher.mock.calls[2];
    const reconcileCall = fetcher.mock.calls[3];
    expect(prepareCall?.[0]).toBe("/api/v1/quote-revision-approvals");
    expect(approveCall?.[0]).toBe(
      "/api/v1/quote-revision-approvals/quote-revision-approval%3Atest-001/approve",
    );
    expect(rejectCall?.[0]).toBe(
      "/api/v1/quote-revision-approvals/quote-revision-approval%3Atest-001/reject",
    );
    expect(reconcileCall?.[0]).toBe(
      "/api/v1/quote-revision-approvals/quote-revision-approval%3Atest-001/reconcile",
    );
    expect(new Headers(prepareCall?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(new Headers(prepareCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "quote-revision-approval:prepare-test-001",
    );
    expect(new Headers(approveCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "quote-revision-approval:approve-test-001",
    );
    expect(new Headers(rejectCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "quote-revision-approval:reject-test-001",
    );
    expect(new Headers(reconcileCall?.[1]?.headers).get("Idempotency-Key")).toBeNull();
    expect(prepareCall?.[1]?.body).toBe(
      JSON.stringify({
        roof_job_id: "ROOF-JOB-001",
        customer_quote_id: "CUSTOMER-QUOTE-001",
        correction_reason:
          "Correct the measurement source before new commercial terms are entered.",
      }),
    );
    expect(approveCall?.[1]?.body).toBe(JSON.stringify({ version: 1 }));
    expect(rejectCall?.[1]?.body).toBe(
      JSON.stringify({ version: 2, reason: "Need a verified measurement source." }),
    );
    expect(reconcileCall?.[1]?.body).toBe(
      JSON.stringify({
        version: 3,
        outcome: "inconclusive",
        evidence: "The Hermes Run record was unavailable; no second revision was issued.",
      }),
    );
  });

  it("rejects a preparation input with any commercial field before it can be sent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      prepareQuoteRevisionApproval(
        session,
        {
          roofJobId: "ROOF-JOB-001",
          customerQuoteId: "CUSTOMER-QUOTE-001",
          correctionReason:
            "Correct the measurement source before new commercial terms are entered.",
          quote_total: 19_500,
        } as never,
        "quote-revision-approval:prepare-test-001",
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("generates separate keys for preparation and approval decisions", () => {
    expect(newQuoteRevisionApprovalPrepareKey()).toMatch(/^quote-revision-approval:prepare:/);
    expect(newQuoteRevisionApprovalDecisionKey()).toMatch(/^quote-revision-approval:decision:/);
  });
});
