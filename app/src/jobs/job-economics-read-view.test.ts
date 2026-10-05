import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { jobEconomicsSchema, loadJobEconomics } from "./job-economics-read-view";
import { economicsFixture, moneyReadFixture } from "./job-read-test-fixtures";

const response = () => ({
  job: { id: "JOB-READ-001" },
  ...moneyReadFixture(),
  allowed_actions: ["quote.update"],
});

describe("job money read boundary", () => {
  it("uses the existing no-store read and retains source limits without write actions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    const read = await loadJobEconomics("freshco", "JOB-READ-001", fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/estimator/jobs/JOB-READ-001",
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
    expect(read).toEqual(moneyReadFixture());
    expect(read).not.toHaveProperty("allowed_actions");
    expect(read?.economics.metrics.forecast_cost.known_cents).toBeNull();
    expect(read?.economics.metrics.posted_actual_cost.known_cents).toBe(0);
  });

  it.each(["job", "economics-job", "tenant"])("refuses a mismatched %s binding", async (field) => {
    const body = response();
    if (field === "job") body.job.id = "OTHER-JOB";
    if (field === "economics-job") body.economics.job_id = "OTHER-JOB";
    if (field === "tenant") body.economics.tenant_id = "other-tenant";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));

    await expect(loadJobEconomics("freshco", "JOB-READ-001", fetcher)).rejects.toThrow(
      "does not match this job",
    );
  });

  it.each([403, 404])(
    "keeps an inaccessible %s money source separate from an empty total",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
      await expect(loadJobEconomics("freshco", "JOB-READ-001", fetcher)).resolves.toBeNull();
    },
  );

  it("does not turn malformed or failed money reads into zero", async () => {
    expect(
      jobEconomicsSchema.safeParse({
        ...economicsFixture(),
        metrics: {
          ...economicsFixture().metrics,
          actual_profit: { amount_cents: 0, state: "complete" },
        },
      }).success,
    ).toBe(false);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "source down" }, { status: 503 }));
    await expect(loadJobEconomics("freshco", "JOB-READ-001", fetcher)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
