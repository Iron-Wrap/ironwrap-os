import type { z } from "zod";

import type { jobResponseSchema } from "../../src/field/field-contracts";
import type { jobHistoryResponseSchema } from "../../src/jobs/job-history-contracts";
import type { productionRunwayResponseSchema } from "../../src/production/production-contracts";

export const identityStates = ["known", "unknown", "legacy", "long", "malformed"] as const;
export type IdentityState = (typeof identityStates)[number];
export type ValidIdentityState = Exclude<IdentityState, "malformed">;
export const syntheticNativeJobId = "native-job:synthetic-d5";

const envelope = {
  version: 1 as const,
  source_updated_at: "2026-07-16T12:00:00.000Z",
  read_model_generated_at: "2026-07-16T12:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read"],
};
const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"] as const;

/** Synthetic read-only DTOs. Legacy omits projection fields; its native job still has them. */
export function productionIdentityFixture(
  state: ValidIdentityState,
): z.input<typeof productionRunwayResponseSchema> {
  return {
    ...envelope,
    partial_sources: [],
    summary: {
      active_jobs: 1,
      blocked: 1,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [
      {
        id: syntheticNativeJobId,
        job_number:
          state === "unknown"
            ? null
            : state === "long"
              ? "IW-SYNTHETIC-JOB-NUMBER-WITH-A-LONG-RECORDED-SUFFIX-0001"
              : "IW-SYNTH-D5",
        ...(state === "legacy"
          ? {}
          : {
              customer_display_name:
                state === "unknown"
                  ? null
                  : state === "long"
                    ? "Synthetic Customer With A Deliberately Long Recorded Organization Name For Wrapping"
                    : "Synthetic Customer One",
              address:
                state === "unknown"
                  ? null
                  : state === "long"
                    ? "Unit 200 - 100 Very Long Synthetic Example Street, Example Municipality, Alberta, Canada"
                    : "2 - 100 Example Street, Example City, AB",
            }),
        brand: "IronWrap Exteriors",
        service_type: "Roofing",
        status: "In Production",
        version: 1,
        assignment: null,
        scheduling_preparation_allowed: false,
        lane: "blocked",
        next_action: "Review the source-backed condition",
        gate_coverage: "complete",
        gate_summary: { expected: 6, blocked: 1, ready: 5, waived: 0, done: 0 },
        scheduling_gates: gateNames.map((name) => ({
          name,
          state: name === "Materials" ? "Blocked" : "Ready",
        })),
        material_attention: [{ status: "Shortage", requested_delivery_date: null }],
      },
    ],
    crews: [],
  };
}

/** Deliberately outside the contract; used only to prove parser refusal and real retry. */
export function malformedProductionIdentityFixture() {
  const valid = productionIdentityFixture("known");
  return { ...valid, jobs: valid.jobs.map((job) => ({ ...job, address: 42 })) };
}

export function nativeJobIdentityFixtures(state: ValidIdentityState) {
  const row = productionIdentityFixture(state === "legacy" ? "known" : state).jobs[0]!;
  const job = {
    id: row.id,
    roof_job_id: row.id,
    job_number: row.job_number,
    brand: row.brand,
    service_type: row.service_type,
    status: row.status,
    address: row.address ?? null,
    current_gate_state: "Blocked",
  };
  const gates = row.scheduling_gates.map((gate) => ({
    id: `${row.id}:gate:${gate.name}`,
    name: gate.name,
    state: gate.state,
    blocker_reason: gate.state === "Blocked" ? "Synthetic material shortage" : null,
    owner: "Synthetic production office",
    due_at: null,
  }));
  const plan: z.input<typeof jobResponseSchema> = {
    ...envelope,
    allowed_actions: [],
    job,
    assignment: null,
    gates,
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: row.customer_display_name
        ? { display_name: row.customer_display_name, phone: null, access_instructions: null }
        : null,
      work_package: null,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
  const history: z.input<typeof jobHistoryResponseSchema> = {
    ...envelope,
    allowed_actions: [],
    job,
    customer: row.customer_display_name
      ? { display_name: row.customer_display_name, phone: null }
      : null,
    gates,
    proof: { items: [], next_cursor: null },
    openable: true,
    proof_unavailable: false,
  };
  return { plan, history };
}
