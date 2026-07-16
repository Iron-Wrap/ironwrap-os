import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  approveApproval,
  loadApprovals,
  newLeadTriageApprovalPrepareKey,
  prepareLeadTriageApproval,
  reconcileApproval,
  rejectApproval,
} from "./approval-api";

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
  permissions: ["approvals:read"],
  allowed_actions: ["approval.approve", "approval.reject"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-11T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function approval() {
  return {
    id: "approval:test-001",
    kind: "lead_triage",
    state: "pending",
    version: 1,
    action: "mark_lead_triaged",
    target: { doctype: "Lead Envelope", name: "lead:test-001", lead_envelope_id: "lead:test-001" },
    request_text: "Record local triage only after owner review.",
    preview: {
      would_write: false,
      target: { doctype: "Lead Envelope", name: "lead:test-001" },
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
        triage_summary: "Hail report",
      },
      transport_status_unchanged: "pushed",
      communication_events_mutated: false,
    },
    expires_at: "2026-07-11T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:lead-triage:test-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2026-07-11T12:00:00.000Z",
    updated_at: "2026-07-11T12:00:00.000Z",
    completed_at: null,
  };
}

describe("approval API", () => {
  it("loads the allowlisted approval inbox through the same-origin BFF", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        read_model_generated_at: "2026-07-11T12:00:00.000Z",
        permissions: ["approvals:read"],
        allowed_actions: ["approval.read"],
        approvals: [approval()],
      }),
    );

    const response = await loadApprovals(fetcher);

    expect(response.approvals[0]?.id).toBe("approval:test-001");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/approvals",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
  });

  it("prepares lead triage through the BFF with only safe input, CSRF, and caller-stable idempotency", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ approval: approval() }));

    await prepareLeadTriageApproval(
      session,
      {
        leadEnvelopeId: "lead:test-001",
        triageSummary: "Hail report received; confirm the inspection window before outreach.",
      },
      "lead-triage-approval:prepare:test-001",
      fetcher,
    );

    const prepareCall = fetcher.mock.calls[0];
    expect(prepareCall?.[0]).toBe("/api/v1/approvals/lead-triage");
    expect(new Headers(prepareCall?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(new Headers(prepareCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "lead-triage-approval:prepare:test-001",
    );
    expect(prepareCall?.[1]?.body).toBe(
      JSON.stringify({
        lead_envelope_id: "lead:test-001",
        triage_summary: "Hail report received; confirm the inspection window before outreach.",
      }),
    );
    expect(newLeadTriageApprovalPrepareKey()).toMatch(/^lead-triage-approval:prepare:/);
  });

  it("rejects request text and broker or commercial data before a browser request is sent", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      prepareLeadTriageApproval(
        session,
        {
          leadEnvelopeId: "lead:test-001",
          triageSummary: "Local triage only.",
          request_text: "The browser must not author a broker request.",
        } as never,
        "lead-triage-approval:prepare:unsafe-input",
        fetcher,
      ),
    ).rejects.toThrow();

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("binds approve and reject decisions to CSRF, version, and a caller-stable idempotency key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ approval: approval() }));

    await approveApproval(session, "approval:test-001", 1, "approval:approve-test-001", fetcher);
    await rejectApproval(
      session,
      "approval:test-001",
      1,
      "Needs a verified inspection window.",
      "approval:reject-test-001",
      fetcher,
    );
    await reconcileApproval(
      session,
      "approval:test-001",
      3,
      "inconclusive",
      "The recorded Hermes Run was unavailable; no second write was issued.",
      fetcher,
    );

    const approveCall = fetcher.mock.calls[0];
    const rejectCall = fetcher.mock.calls[1];
    const reconcileCall = fetcher.mock.calls[2];
    expect(approveCall?.[0]).toBe("/api/v1/approvals/approval%3Atest-001/approve");
    expect(rejectCall?.[0]).toBe("/api/v1/approvals/approval%3Atest-001/reject");
    expect(reconcileCall?.[0]).toBe("/api/v1/approvals/approval%3Atest-001/reconcile");
    expect(new Headers(approveCall?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(new Headers(approveCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "approval:approve-test-001",
    );
    expect(approveCall?.[1]?.body).toBe(JSON.stringify({ version: 1 }));
    expect(rejectCall?.[1]?.body).toBe(
      JSON.stringify({ version: 1, reason: "Needs a verified inspection window." }),
    );
    expect(reconcileCall?.[1]?.body).toBe(
      JSON.stringify({
        version: 3,
        outcome: "inconclusive",
        evidence: "The recorded Hermes Run was unavailable; no second write was issued.",
      }),
    );
  });
});
