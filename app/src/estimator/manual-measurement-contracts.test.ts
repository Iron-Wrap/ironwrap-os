import { describe, expect, it } from "vitest";
import {
  manualMeasurementInputSchema,
  manualMeasurementsResponseSchema,
} from "./manual-measurement-contracts";
const input = {
  expected_job_version: 1,
  expected_observation_head: null,
  target: { new_area_label: "South roof" },
  area_sq_ft: 1000,
  area_basis: "roof_surface",
  pitch_rise_per_12: 0,
  method: "plans",
  uncertainty: null,
  correction_reason: null,
};
describe("manual measurements strict contract", () => {
  it("distinguishes zero pitch, unknown area basis, missing facts and corrections", () => {
    expect(manualMeasurementInputSchema.parse(input).pitch_rise_per_12).toBe(0);
    expect(
      manualMeasurementInputSchema.safeParse({ ...input, area_sq_ft: null, area_basis: "unknown" })
        .success,
    ).toBe(true);
    for (const bad of [
      { ...input, area_sq_ft: 0 },
      { ...input, area_sq_ft: null, pitch_rise_per_12: null },
      { ...input, area_sq_ft: null },
      { ...input, pitch_rise_per_12: NaN },
      { ...input, method: "" },
      { ...input, uncertainty: "" },
      { ...input, source: "geometry" },
      { ...input, target: { area_id: `marea_${"a".repeat(64)}` } },
    ])
      expect(manualMeasurementInputSchema.safeParse(bad).success).toBe(false);
    expect(
      manualMeasurementInputSchema.safeParse({
        ...input,
        target: { area_id: `marea_${"a".repeat(64)}` },
        correction_reason: "New field reading",
      }).success,
    ).toBe(true);
  });
  it("represents a confirmed missing receipt without inventing successful recording", () => {
    const model = {
      version: 1,
      tenant_id: "ironwrap",
      read_model_generated_at: "2026-09-30T12:00:00.000Z",
      job: { id: "job:manual:fixture", version: 1, job_number: null },
      allowed_actions: [],
      observation_head: null,
      areas: [],
      history: { items: [], next_before: null },
      requested_request_id: "manual-measurement:11111111-1111-4111-8111-111111111111",
      receipt: null,
    };
    expect(manualMeasurementsResponseSchema.parse(model).receipt).toBeNull();
    expect(
      manualMeasurementsResponseSchema.safeParse({ ...model, computed_takeoff: {} }).success,
    ).toBe(false);
  });
});
