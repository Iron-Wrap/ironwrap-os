import { describe, expect, it } from "vitest";

import {
  measurementIntakeOwnerExceptionsResponseSchema,
  ownerNowResponseSchema,
  ownerRuntimeResponseSchema,
} from "./owner-contracts";

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

function ownerRuntimePayload() {
  return {
    version: 1,
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    status: "attention",
    readiness: {
      status: "not_ready",
      checks: [
        { id: "owned_persistence", ok: true },
        { id: "queue", ok: true },
        { id: "core_auth", ok: true },
        { id: "provider_delivery", ok: true },
        { id: "office_bff", ok: false },
        { id: "customer_portal", ok: true },
        { id: "production_schedule", ok: true },
        { id: "public_estimate", ok: true },
        { id: "newo", ok: true },
      ],
    },
    operations: {
      status: "degraded",
      heartbeat: null,
      counts: {
        open_dead_letters: 1,
        pending: 0,
        stuck: 0,
        frappe_errors: 0,
        replay_failed: 0,
        replay_stuck: 0,
      },
      audit_failures_observed: 0,
      audit_failure_window_hours: 24,
      quickbooks_receipts: {
        available: false,
        fresh: null,
        age_seconds: null,
        events_count: null,
        replay_count: null,
      },
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

  it("accepts only the browser-safe measurement exception projection", () => {
    const payload = {
      measurements: [
        {
          id: `measurement_${"b".repeat(64)}`,
          provider: "RoofRuler",
          job_number: "26-0004",
          status: "retryable_error",
          reason: "drive_not_configured",
          drive_report_url: "https://drive.google.com/open?id=report",
          drive_folder_url: null,
          attempts: 2,
          recovery_disposition: "retry_scheduled",
          created_at: "2026-07-16T12:00:00.000Z",
          updated_at: "2026-07-16T12:01:00.000Z",
        },
      ],
    };

    expect(measurementIntakeOwnerExceptionsResponseSchema.safeParse(payload).success).toBe(true);
    expect(
      measurementIntakeOwnerExceptionsResponseSchema.safeParse({
        ...payload,
        measurements: [{ ...payload.measurements[0], lease_token: "must-not-reach-browser" }],
      }).success,
    ).toBe(false);
    expect(
      measurementIntakeOwnerExceptionsResponseSchema.safeParse({
        ...payload,
        measurements: [{ ...payload.measurements[0], recovery_disposition: "manual_review" }],
      }).success,
    ).toBe(false);
  });

  it("accepts the bounded runtime summary but rejects diagnostic payloads", () => {
    const payload = ownerRuntimePayload();

    expect(ownerRuntimeResponseSchema.safeParse(payload).success).toBe(true);
    expect(
      ownerRuntimeResponseSchema.safeParse({
        ...payload,
        operations: {
          ...payload.operations,
          recent_audit_failures: [{ error: "must-not-reach-browser" }],
        },
      }).success,
    ).toBe(false);
    expect(
      ownerRuntimeResponseSchema.safeParse({
        ...payload,
        readiness: { ...payload.readiness, checks: [...payload.readiness.checks].reverse() },
      }).success,
    ).toBe(false);
  });
});
