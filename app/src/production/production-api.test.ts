import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { API_PATHS } from "../lib/api-paths";
import { loadProductionRunway, scheduleProductionJob } from "./production-api";

function payload() {
  return {
    version: 1,
    source_updated_at: "2026-07-16T12:00:00.000Z",
    read_model_generated_at: "2026-07-16T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read"],
    partial_sources: [],
    summary: {
      active_jobs: 0,
      blocked: 0,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [],
    crews: [],
  };
}

describe("Production runway API client", () => {
  it("uses the shared same-origin client for the read-only production endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));

    await loadProductionRunway(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      API_PATHS.production,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("rejects an incomplete response instead of rendering an inferred runway", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...payload(), summary: { active_jobs: 1 } }));

    await expect(loadProductionRunway(fetcher)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("posts the exact native scheduling command with CSRF and idempotency", async () => {
    const response = {
      version: 1,
      assignment: {
        id: "assignment:schedule:0001",
        assignment_version: 1,
        roof_job_id: "job:schedule:0001",
        roof_job_version: 5,
        crew_id: "crew:schedule:0001",
        crew_version: 7,
        assigned_users: ["appu_field_schedule"],
        scheduled_start: "2026-08-24T14:00:00.000Z",
        scheduled_end: "2026-08-24T22:00:00.000Z",
        supersedes_assignment_id: null,
        correction_reason: null,
        actor_user_id: "appu_ops",
        created_at: "2026-08-21T12:00:00.000Z",
      },
      replayed: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));

    await scheduleProductionJob(
      { csrf_token: "csrf-token" } as AuthenticatedSession,
      {
        roofJobId: "job:schedule:0001",
        expectedRoofJobVersion: 5,
        crewId: "crew:schedule:0001",
        expectedCrewVersion: 7,
        scheduledStart: "2026-08-24T14:00:00.000Z",
        scheduledEnd: "2026-08-24T22:00:00.000Z",
        supersedesAssignmentId: null,
        correctionReason: null,
      },
      "operating-job-assignment:test-0001",
      fetcher,
    );

    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(API_PATHS.productionJobSchedule("job:schedule:0001"));
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          expected_roof_job_version: 5,
          crew_id: "crew:schedule:0001",
          expected_crew_version: 7,
          scheduled_start: "2026-08-24T14:00:00.000Z",
          scheduled_end: "2026-08-24T22:00:00.000Z",
          supersedes_assignment_id: null,
          correction_reason: null,
        }),
      }),
    );
    const headers = init?.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(headers.get("Idempotency-Key")).toBe("operating-job-assignment:test-0001");
  });
});
