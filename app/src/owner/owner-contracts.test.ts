import { describe, expect, it } from "vitest";

import { ownerNowResponseSchema } from "./owner-contracts";

function ownerNowPayload() {
  return {
    version: 1,
    source_updated_at: "2026-07-10T12:00:00.000Z",
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    stale_fields: ["exceptions.next_action"],
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    exceptions: [
      {
        id: "gate_a",
        kind: "blocked_gate",
        severity: null,
        title: "Materials gate blocked",
        why: "Delivery not confirmed",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: null,
        due_at: "2026-07-11 12:00:00",
        received_at: null,
        bus_status: null,
        triage_status: null,
        mctb: null,
      },
    ],
    partial_sources: [],
    summary: {
      active_jobs: 3,
      field_blockers: 0,
      blocked_gates: 1,
      open_incidents: 0,
      finance_exceptions: 0,
      untriaged_leads: 0,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 0,
    },
  };
}

describe("Owner Now read model contract", () => {
  it("accepts the complete owner/ops exception envelope including nullable evidence fields", () => {
    const parsed = ownerNowResponseSchema.safeParse(ownerNowPayload());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.exceptions[0]).toMatchObject({
        kind: "blocked_gate",
        severity: null,
        next_action: null,
        occurred_at: null,
        mctb: null,
      });
    }
  });

  it("rejects malformed versioned summaries instead of rendering a partial queue", () => {
    const invalid = ownerNowPayload();
    invalid.version = 2;
    invalid.summary.blocked_gates = -1;

    expect(ownerNowResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
