import { describe, expect, it } from "vitest";

import {
  productionScheduleApprovalPreparationInputSchema,
  productionScheduleApprovalRequestSchema,
} from "./production-schedule-approval-contracts";

function approval() {
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
    scheduled_end: "2026-07-20T22:00:00.000Z",
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
        scheduled_end: "2026-07-20T22:00:00.000Z",
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
  };
}

describe("production schedule approval contracts", () => {
  it("accepts only a bounded crew-profile scheduling preparation", () => {
    expect(
      productionScheduleApprovalPreparationInputSchema.safeParse({
        roofJobId: "JOB-001",
        crewProfileId: "crew:metal-1",
        scheduledStart: "2026-07-20T14:00:00.000Z",
        scheduledEnd: "2026-07-20T22:00:00.000Z",
        supersedesAssignmentId: "assignment:old",
        correctionReason: "Weather moved the install window.",
      }).success,
    ).toBe(true);
    expect(
      productionScheduleApprovalPreparationInputSchema.safeParse({
        roofJobId: "JOB-001",
        crewProfileId: "crew:metal-1",
        scheduledStart: "2026-07-20T14:00:00.000Z",
        scheduledEnd: "2026-07-20T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      productionScheduleApprovalPreparationInputSchema.safeParse({
        roofJobId: "JOB-001",
        crewProfileId: "crew:metal-1",
        scheduledStart: "2026-07-20T14:00:00.000Z",
        correctionReason: "Weather moved the install window.",
      }).success,
    ).toBe(false);
    expect(
      productionScheduleApprovalPreparationInputSchema.safeParse({
        roofJobId: "JOB-001",
        crewProfileId: "crew:metal-1",
        scheduledStart: "2026-07-20T14:00:00.000Z",
        assignedUser: "field@ironwrapexteriors.com",
      }).success,
    ).toBe(false);
  });

  it("rejects receipts, raw write data, and a preview that drifts from the requested assignment", () => {
    expect(productionScheduleApprovalRequestSchema.safeParse(approval()).success).toBe(true);
    expect(
      productionScheduleApprovalRequestSchema.safeParse({
        ...approval(),
        dry_run_receipt: "must-never-reach-browser",
      }).success,
    ).toBe(false);
    expect(
      productionScheduleApprovalRequestSchema.safeParse({
        ...approval(),
        preview: {
          ...approval().preview,
          assignment: { ...approval().preview.assignment, crew_profile_id: "crew:other" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a refusal reason only on a refused schedule, and only as plain text", () => {
    // ELEC-132 defect B: this sentence is the one part of a failed execution an office
    // user reads as prose, so the browser re-checks the same rule the Worker and the
    // storage boundary already enforce - a widened server must not be able to start
    // rendering markup, a newline, or a paragraph in an office surface.
    const refused = {
      ...approval(),
      state: "failed",
      completed_at: "2026-07-20T14:05:00.000Z",
      error_code: "broker_production_schedule_refused",
      refusal_message:
        "the exact tenant-scoped Authority Record requirements are not satisfied: Worker " +
        "Competency for crew@ironwrap.local scoped to Roof Job JOB-001",
    };
    expect(productionScheduleApprovalRequestSchema.safeParse(refused).success).toBe(true);

    for (const message of [
      "<script>alert(1)</script>",
      "line one\nline two",
      "x".repeat(401),
      "",
    ]) {
      expect(
        productionScheduleApprovalRequestSchema.safeParse({ ...refused, refusal_message: message })
          .success,
      ).toBe(false);
    }

    // An uncertain execution means nobody knows what happened; a confident sentence there
    // would read as a decision that was never made.
    for (const state of ["execution_uncertain", "audit_failed", "executing", "pending"]) {
      expect(productionScheduleApprovalRequestSchema.safeParse({ ...refused, state }).success).toBe(
        false,
      );
    }
  });
});
