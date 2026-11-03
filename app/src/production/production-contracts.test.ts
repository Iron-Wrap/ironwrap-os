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
        version: 3,
        assignment: {
          id: "assignment:iw-1001-production",
          type: "Production",
          status: "Assigned",
          assignment_version: 2,
          roof_job_version: 3,
          crew_id: "crew:metal-a",
          crew_version: 4,
          scheduled_start: null,
          scheduled_end: null,
        },
        scheduling_preparation_allowed: true,
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
    crews: [{ id: "crew:metal-a", name: "Metal A", version: 4 }],
  };
}

describe("Production runway read model contract", () => {
  it("accepts the narrow operational projection", () => {
    const parsed = productionRunwayResponseSchema.parse(payload());
    expect(parsed.jobs[0]).toMatchObject({ customer_display_name: null, address: null });
  });

  it.each([
    { customer_display_name: "Synthetic Customer A", address: "2 - 100 Example Street" },
    { customer_display_name: null, address: null },
    { customer_display_name: "  ", address: "" },
  ])("accepts only the optional nullable job identity additions: %j", (identity) => {
    const legacy = payload();
    const parsed = productionRunwayResponseSchema.parse({
      ...legacy,
      jobs: [{ ...legacy.jobs[0], ...identity }],
    });

    expect(parsed.jobs[0]).toMatchObject({
      customer_display_name: identity.customer_display_name?.trim() || null,
      address: identity.address?.trim() || null,
    });
    expect(parsed.jobs[0]?.id).toBe("JOB-A");
    expect(parsed.jobs[0]?.job_number).toBe("IW-1001");
  });

  it.each([0, false, [], {}, ["Synthetic Customer A"]])(
    "rejects malformed identity rather than treating it as missing: %j",
    (value) => {
      const legacy = payload();
      for (const field of ["customer_display_name", "address"]) {
        expect(
          productionRunwayResponseSchema.safeParse({
            ...legacy,
            jobs: [{ ...legacy.jobs[0], [field]: value }],
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each(["roof_job_id", "customer_name", "customer_phone", "site_address"])(
    "keeps unagreed identity fields outside the strict contract: %s",
    (field) => {
      const legacy = payload();
      expect(
        productionRunwayResponseSchema.safeParse({
          ...legacy,
          jobs: [{ ...legacy.jobs[0], [field]: "not-admitted" }],
        }).success,
      ).toBe(false);
    },
  );

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
