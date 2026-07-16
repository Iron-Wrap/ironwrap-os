import { describe, expect, it, vi } from "vitest";

import {
  loadMeasurementIntakeExceptions,
  loadOwnerNow,
  measurementIntakeExceptionsPath,
  ownerNowPath,
} from "./owner-api";

function ownerNowPayload() {
  return {
    version: 1,
    source_updated_at: "2026-07-10T12:00:00.000Z",
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    stale_fields: [],
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    exceptions: [],
    partial_sources: [],
    summary: {
      active_jobs: 0,
      field_blockers: 0,
      blocked_gates: 0,
      open_incidents: 0,
      finance_exceptions: 0,
      untriaged_leads: 0,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 0,
    },
  };
}

function measurementExceptionsPayload() {
  return {
    measurements: [
      {
        id: `measurement_${"a".repeat(64)}`,
        provider: "RoofRuler",
        job_number: null,
        status: "unmatched",
        reason: "job_number_missing",
        drive_report_url: null,
        drive_folder_url: null,
        attempts: 1,
        recovery_disposition: "manual_review",
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:00:00.000Z",
      },
    ],
  };
}

describe("Owner Now API client", () => {
  it("uses the shared same-origin API client against the read-only owner endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ownerNowPayload()));

    await loadOwnerNow(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      ownerNowPath,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("does not accept a response that misses the exception summary contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...ownerNowPayload(), summary: { active_jobs: 1 } }));

    await expect(loadOwnerNow(fetcher)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the narrow read-only measurement exception endpoint", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(measurementExceptionsPayload()));

    await loadMeasurementIntakeExceptions(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      measurementIntakeExceptionsPath,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("rejects an exception response that carries raw diagnostic fields", async () => {
    const payload = measurementExceptionsPayload();
    payload.measurements[0] = {
      ...payload.measurements[0],
      raw_key: "raw/measurements/secret.json",
    } as never;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));

    await expect(loadMeasurementIntakeExceptions(fetcher)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
