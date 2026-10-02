import { describe, expect, it, vi } from "vitest";
import { sessionFor } from "../admin/admin-test-harness";
import {
  loadManualMeasurements,
  newManualMeasurementRequestId,
  recordManualMeasurement,
} from "./manual-measurement-api";
import type { ManualMeasurementInput, ManualObservation } from "./manual-measurement-contracts";
const requestId = "manual-measurement:11111111-1111-4111-8111-111111111111";
const session = sessionFor("owner");
const jobId = "job:manual:fixture";
const input: ManualMeasurementInput = {
  expected_job_version: 1,
  expected_observation_head: null,
  target: { new_area_label: "South roof" },
  area_sq_ft: 1200,
  area_basis: "roof_surface",
  pitch_rise_per_12: 6,
  method: "tape",
  uncertainty: null,
  correction_reason: null,
};
const observation: ManualObservation = {
  id: `mobs_${"a".repeat(64)}`,
  job_id: jobId,
  area_id: `marea_${"b".repeat(64)}`,
  area_label: "South roof",
  revision: 1,
  sequence: 1,
  area_sq_ft: 1200,
  area_basis: "roof_surface",
  pitch_rise_per_12: 6,
  method: "tape",
  uncertainty: null,
  correction_reason: null,
  supersedes_observation_id: null,
  previous_head_id: null,
  job_version: 1,
  recorded_by: session.user.id,
  recorded_at: "2026-09-30T12:00:00.000Z",
  sha256: "c".repeat(64),
};
const receipt = { request_id: requestId, request_hash: "d".repeat(64), observation };
const result = {
  version: 1,
  tenant_id: session.tenant.id,
  job_id: jobId,
  receipt,
  replayed: false,
};
const model = {
  version: 1,
  tenant_id: session.tenant.id,
  read_model_generated_at: "2026-09-30T12:00:00.000Z",
  job: { id: jobId, version: 1, job_number: null },
  allowed_actions: ["manual_measurement.record"],
  observation_head: observation.id,
  areas: [observation],
  history: { items: [observation], next_before: null },
  requested_request_id: requestId,
  receipt,
};

describe("manual measurement transport", () => {
  it("posts the immutable caller identity and facts with CSRF, then recovers through a read only query", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json(model));
    expect(newManualMeasurementRequestId()).toMatch(/^manual-measurement:[0-9a-f-]{36}$/);
    await expect(
      recordManualMeasurement(session, jobId, input, requestId, fetcher),
    ).resolves.toEqual(result);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/estimator/jobs/job%3Amanual%3Afixture/manual-measurements");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe(session.csrf_token);
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(requestId);
    expect(JSON.parse(String(init?.body))).toEqual(input);
    await expect(loadManualMeasurements(jobId, { requestId, before: 9 }, fetcher)).resolves.toEqual(
      model,
    );
    expect(fetcher.mock.calls[1]![0]).toContain(
      `request_id=${encodeURIComponent(requestId)}&before=9`,
    );
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(fetcher.mock.calls[1]![1]?.body).toBeUndefined();
  });
  it.each(["job", "tenant", "request", "actor"])(
    "rejects a successful command response for the wrong %s",
    async (kind) => {
      const other = structuredClone(result);
      if (kind === "job") other.job_id = "job:other:fixture";
      if (kind === "tenant") other.tenant_id = "other-co";
      if (kind === "request")
        other.receipt.request_id = "manual-measurement:22222222-2222-4222-8222-222222222222";
      if (kind === "actor") other.receipt.observation.recorded_by = "other-user";
      await expect(
        recordManualMeasurement(
          session,
          jobId,
          input,
          requestId,
          vi.fn<typeof fetch>().mockResolvedValue(Response.json(other)),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses a mismatched lookup acknowledgement or invalid input without writing", async () => {
    await expect(
      loadManualMeasurements(
        jobId,
        { requestId },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ ...model, requested_request_id: null, receipt: null }),
          ),
      ),
    ).rejects.toThrow();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      recordManualMeasurement(
        session,
        jobId,
        { ...input, pitch_rise_per_12: Infinity },
        requestId,
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
