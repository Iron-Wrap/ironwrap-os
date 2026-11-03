import { describe, expect, it } from "vitest";

import { ApiError } from "../../lib/api";
import {
  gateEntryResponseSchema,
  jobGatesResponseSchema,
  signedCopyQueueResponseSchema,
  signedCopyRecordResponseSchema,
  waiverDecisionResponseSchema,
} from "./gate-contracts";
import { gateRefusal, recordRefusal } from "./gate-refusals";
import { entry, model, queue, readyToSchedule, request, windowState } from "./gate-test-fixtures";

describe("the gate train's office contracts", () => {
  it("reads the Worker's gates answer with the window beside the gates, and refuses a widened one", () => {
    const answer = model("open");
    answer.gates[1] = { ...answer.gates[1]!, open_waiver_requests: [request()] };
    expect(jobGatesResponseSchema.parse(answer)).toEqual(answer);
    expect(jobGatesResponseSchema.parse(readyToSchedule()).gates).toHaveLength(6);
    expect(() =>
      jobGatesResponseSchema.parse({
        ...answer,
        cancellation_window: { ...answer.cancellation_window, extra: 1 },
      }),
    ).toThrow();
    expect(() =>
      jobGatesResponseSchema.parse({
        ...answer,
        cancellation_window: { ...answer.cancellation_window, waivable: true },
      }),
    ).toThrow();
  });

  it("reads each unknown reason, and refuses one it does not know", () => {
    for (const reason of [
      "signed_copy_time_missing",
      "signed_copy_unconfirmed",
      "signed_copy_before_contract",
    ] as const) {
      expect(
        jobGatesResponseSchema.parse(model("unknown", {}, { unknown_reason: reason }))
          .cancellation_window.unknown_reason,
      ).toBe(reason);
    }
    expect(() =>
      jobGatesResponseSchema.parse(model("unknown", {}, { unknown_reason: "later" as never })),
    ).toThrow();
  });

  it("reads the write answers: an entry, a waiver decision, a record and the work queue", () => {
    const appended = entry({ from_gate_version: 1 });
    expect(
      gateEntryResponseSchema.parse({
        entry: appended,
        gate: {
          name: "gate:materials",
          gate: "Materials",
          roof_job: "r",
          state: "ready",
          version: 2,
        },
        replayed: false,
      }).entry.id,
    ).toBe(appended.id);
    expect(
      waiverDecisionResponseSchema.parse({
        decision: {
          clearance_id: appended.id,
          request_id: request().request_id,
          decision: "approve",
          requested_by: "appu_production_synthetic",
          decided_by: "appu_owner_synthetic",
          actor_role: "owner",
          self_approval: false,
          self_approval_basis: null,
          reason: "I checked the shingles at the yard this morning.",
          created_at: "2026-11-02T14:30:00.000Z",
        },
        gate: {
          name: "gate:materials",
          gate: "Materials",
          roof_job: "r",
          state: "waived",
          version: 3,
        },
        replayed: false,
      }).decision.decision,
    ).toBe("approve");
    expect(
      signedCopyRecordResponseSchema.parse({
        cancellation_window: windowState("open"),
        recorded: true,
        receipt_id: "pcw_synthetic",
        replayed: false,
      }).recorded,
    ).toBe(true);
    expect(
      signedCopyRecordResponseSchema.parse({
        cancellation_window: windowState("open"),
        recorded: false,
        unchanged: true,
        replayed: false,
      }).unchanged,
    ).toBe(true);
    expect(signedCopyQueueResponseSchema.parse(queue).count).toBe(3);
  });
});

const refused = (code: string, details: Record<string, unknown> = {}) =>
  new ApiError({ message: code, status: 409, code, details: { error: code, ...details } });

describe("each refusal is drawn as its frame", () => {
  it.each([
    ["production_gate_safety_permit_unknown", "permit_unknown"],
    ["production_gate_attester_on_crew", "on_crew"],
    ["production_gate_competency_required", "competency"],
    ["production_gate_safety_stop_active", "stop"],
    ["production_gate_stop_job_unknown", "stop"],
    ["production_gate_stop_work_package_unknown", "stop"],
    ["production_gate_material_exception_open", "material_problem"],
    ["production_gate_forecast_stale", "forecast_stale"],
    ["production_gate_weather_window_invalid", "weather_window_invalid"],
    ["production_gate_cancellation_window_unknown", "window_held"],
    ["production_gate_cancellation_window_open", "window_held"],
    ["production_gate_not_waivable", "not_waivable"],
    ["production_gate_waiver_requested", "waiver_requested"],
    ["production_gate_waiver_request_open", "waiver_requested"],
    ["production_gate_version_conflict", "message"],
  ])("%s → %s", (code, kind) => {
    expect(gateRefusal(refused(code)).kind).toBe(kind);
  });

  it("keeps the stop to open from an unknown-scope stop", () => {
    expect(gateRefusal(refused("production_gate_stop_job_unknown", { stop_id: "occ_1" }))).toEqual({
      kind: "stop",
      variant: "job_unknown",
      stopId: "occ_1",
    });
  });

  it("words every other refusal plainly, never generically", () => {
    const refusal = gateRefusal(refused("production_gate_version_conflict"));
    expect(refusal.kind === "message" && refusal.text).toBe(
      "Someone changed this gate while you had it open. Nothing was saved. Load the gates again to see it.",
    );
  });

  it("maps the record step's refusals to frames 20c, 21, 22 and 23 with the times they carry", () => {
    expect(
      recordRefusal(refused("cancellation_window_receipt_reason_and_evidence_required")),
    ).toEqual({
      kind: "missing",
      reason: true,
      evidence: true,
    });
    expect(recordRefusal(refused("cancellation_window_receipt_reason_required"))).toEqual({
      kind: "missing",
      reason: true,
      evidence: false,
    });
    expect(recordRefusal(refused("cancellation_window_receipt_evidence_required"))).toEqual({
      kind: "missing",
      reason: false,
      evidence: true,
    });
    expect(
      recordRefusal(
        refused("cancellation_window_receipt_before_contract", {
          received_at: "a",
          contract_signed_at: "b",
          time_zone: "America/Edmonton",
        }),
      ).kind,
    ).toBe("before_contract");
    expect(
      recordRefusal(
        refused("cancellation_window_receipt_in_future", { received_at: "a", now: "b" }),
      ).kind,
    ).toBe("in_future");
    expect(
      recordRefusal(
        refused("cancellation_window_receipt_earlier_than_recorded", {
          received_at: "a",
          recorded_received_at: "b",
          recorded_source: "manual_record",
        }),
      ).kind,
    ).toBe("earlier");
    // A refusal that lost its times is still words, never a blank frame.
    expect(recordRefusal(refused("cancellation_window_receipt_before_contract")).kind).toBe(
      "message",
    );
    expect(recordRefusal(refused("cancellation_window_receipt_owner_or_ops_required")).kind).toBe(
      "message",
    );
  });
});
