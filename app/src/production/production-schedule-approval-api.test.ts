import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { API_PATHS } from "../lib/api-paths";
import { prepareProductionScheduleApproval } from "./production-schedule-approval-api";

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
});
