import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { API_PATHS } from "../lib/api-paths";
import {
  approveProductionScheduleApproval,
  prepareProductionScheduleApproval,
  reconcileProductionScheduleApproval,
  rejectProductionScheduleApproval,
} from "./production-schedule-approval-api";

const session = {
  csrf_token: "csrf-token",
} as AuthenticatedSession;

function payload() {
  return {
    approval: {
      id: "production-schedule-approval:api-001",
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
      run_id: "run:production-schedule:api-001",
      hermes_run_id: null,
      outcome: null,
      error_code: null,
      refusal_message: null,
      reconciliation: null,
      created_at: "2026-07-19T12:00:00.000Z",
      updated_at: "2026-07-19T12:00:00.000Z",
      completed_at: null,
    },
  };
}

describe("production schedule approval API client", () => {
  it("sends only the bounded crew scheduling intent with CSRF and idempotency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));

    await prepareProductionScheduleApproval(
      session,
      {
        roofJobId: "JOB-001",
        crewProfileId: "crew:metal-1",
        scheduledStart: "2026-07-20T14:00:00.000Z",
      },
      "production-schedule-approval:prepare:test",
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(API_PATHS.productionScheduleApprovals);
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          roof_job_id: "JOB-001",
          crew_profile_id: "crew:metal-1",
          scheduled_start: "2026-07-20T14:00:00.000Z",
          scheduled_end: null,
          supersedes_assignment_id: null,
          correction_reason: null,
        }),
      }),
    );
    expect(init?.headers).toBeInstanceOf(Headers);
    const headers = init?.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(headers.get("Idempotency-Key")).toBe("production-schedule-approval:prepare:test");
  });

  it("posts approve, reject, and reconcile to the bounded decision paths", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload()));

    await approveProductionScheduleApproval(
      session,
      "production-schedule-approval:api-001",
      1,
      "production-schedule-approval:approve:test",
      fetcher,
    );
    await rejectProductionScheduleApproval(
      session,
      "production-schedule-approval:api-001",
      2,
      "Crew window conflicts with weather hold.",
      "production-schedule-approval:reject:test",
      fetcher,
    );
    await reconcileProductionScheduleApproval(
      session,
      "production-schedule-approval:api-001",
      3,
      "inconclusive",
      "The Hermes Run was unavailable; no second assignment was issued.",
      fetcher,
    );

    const approveCall = fetcher.mock.calls[0];
    const rejectCall = fetcher.mock.calls[1];
    const reconcileCall = fetcher.mock.calls[2];
    expect(approveCall?.[0]).toBe(
      "/api/v1/production-schedule-approvals/production-schedule-approval%3Aapi-001/approve",
    );
    expect(rejectCall?.[0]).toBe(
      "/api/v1/production-schedule-approvals/production-schedule-approval%3Aapi-001/reject",
    );
    expect(reconcileCall?.[0]).toBe(
      "/api/v1/production-schedule-approvals/production-schedule-approval%3Aapi-001/reconcile",
    );
    expect(JSON.parse(String(approveCall?.[1]?.body))).toEqual({ version: 1 });
    expect(JSON.parse(String(rejectCall?.[1]?.body))).toEqual({
      version: 2,
      reason: "Crew window conflicts with weather hold.",
    });
    expect(JSON.parse(String(reconcileCall?.[1]?.body))).toEqual({
      version: 3,
      outcome: "inconclusive",
      evidence: "The Hermes Run was unavailable; no second assignment was issued.",
    });
    expect(new Headers(approveCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "production-schedule-approval:approve:test",
    );
    expect(new Headers(rejectCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      "production-schedule-approval:reject:test",
    );
  });
});
