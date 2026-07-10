import { describe, expect, it, vi } from "vitest";

import { loadOwnerNow, ownerNowPath } from "./owner-api";

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
});
