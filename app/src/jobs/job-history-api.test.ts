import { describe, expect, it, vi } from "vitest";

import { loadJobHistory } from "./job-history-api";
import type { JobHistoryResponse } from "./job-history-contracts";

const record: JobHistoryResponse = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-10-02T10:00:00.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: [],
  job: {
    id: "JOB-READ-001",
    roof_job_id: "JOB-READ-001",
    job_number: null,
    brand: "FreshCo",
    service_type: null,
    status: "Complete",
    address: null,
    current_gate_state: "Complete",
  },
  customer: null,
  gates: [],
  proof: { items: [], next_cursor: null },
  openable: false,
  proof_unavailable: false,
};

describe("job record source binding", () => {
  it("reads the exact job and keeps an older-event cursor in the request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record));
    await expect(loadJobHistory("JOB-READ-001", "older:001", fetcher)).resolves.toEqual(record);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/jobs/JOB-READ-001/history?cursor=older%3A001",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("rejects another job even when its event envelope is otherwise valid", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...record,
        job: { ...record.job, id: "OTHER-JOB", roof_job_id: "OTHER-JOB" },
      }),
    );
    await expect(loadJobHistory("JOB-READ-001", null, fetcher)).rejects.toThrow(
      "does not match this link",
    );
  });
});
