import { describe, expect, it } from "vitest";

import { approvalListResponseSchema, approvalRequestSchema } from "./approval-contracts";

function approvalPayload() {
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
        triage_summary: "Hail report; confirm inspection window before outreach.",
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

describe("approval browser contract", () => {
  it("accepts only the explicit, display-safe review DTO", () => {
    const payload = {
      version: 1,
      read_model_generated_at: "2026-07-11T12:00:00.000Z",
      permissions: ["approvals:read"],
      allowed_actions: ["approval.read"],
      approvals: [approvalPayload()],
    };

    expect(approvalListResponseSchema.parse(payload)).toEqual(payload);
  });

  it("fails closed if a capability, raw write arguments, or broker output crosses the boundary", () => {
    expect(
      approvalRequestSchema.safeParse({
        ...approvalPayload(),
        dry_run_receipt: "must-never-reach-the-browser",
      }).success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({
        ...approvalPayload(),
        preview: {
          ...approvalPayload().preview,
          approval_request: { dry_run_receipt: "must-never-reach-the-browser" },
        },
      }).success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({
        ...approvalPayload(),
        outcome: { raw_broker_output: "never render this" },
      }).success,
    ).toBe(false);
  });
});
