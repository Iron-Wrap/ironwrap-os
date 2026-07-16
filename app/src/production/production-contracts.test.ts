import { describe, expect, it } from "vitest";

import { productionRunwayResponseSchema } from "./production-contracts";

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
      active_jobs: 1,
      blocked: 0,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 1,
      needs_verification: 0,
    },
    jobs: [
      {
        id: "JOB-A",
        job_number: "IW-1001",
        brand: "IronWrap Exteriors",
        service_type: "Roofing",
        status: "In Production",
        assignment: {
          type: "Production",
          status: "Assigned",
          scheduled_start: null,
          scheduled_end: null,
        },
        lane: "ready_for_review",
        next_action: "Review for scheduling; this view does not dispatch work",
        gate_coverage: "complete",
        gate_summary: { expected: 6, blocked: 0, ready: 6, waived: 0, done: 0 },
        scheduling_gates: [
          { name: "Deposit", state: "Ready" },
          { name: "Materials", state: "Ready" },
          { name: "Safety", state: "Ready" },
          { name: "Access", state: "Ready" },
          { name: "Weather", state: "Ready" },
          { name: "Crew", state: "Ready" },
        ],
        material_attention: [],
      },
    ],
  };
}

describe("Production runway read model contract", () => {
  it("accepts the narrow operational projection", () => {
    expect(productionRunwayResponseSchema.safeParse(payload()).success).toBe(true);
  });

  it("rejects a response that attempts to widen the browser contract", () => {
    const widened = payload();
    widened.jobs[0] = { ...widened.jobs[0], customer_email: "private@example.com" } as never;

    expect(productionRunwayResponseSchema.safeParse(widened).success).toBe(false);
  });

  it("rejects a scheduling-gate projection that adds a closeout gate", () => {
    const widened = payload();
    const firstJob = widened.jobs[0];
    if (!firstJob) throw new Error("missing_test_job");
    widened.jobs[0] = {
      ...firstJob,
      scheduling_gates: firstJob.scheduling_gates.map((gate, index) =>
        index === 5 ? { ...gate, name: "Completion" } : gate,
      ),
    } as never;

    expect(productionRunwayResponseSchema.safeParse(widened).success).toBe(false);
  });
});
