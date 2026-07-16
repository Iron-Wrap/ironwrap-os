import { describe, expect, it, vi } from "vitest";

import { loadCustomerPortal } from "./portal-api";

const portal = {
  version: 1,
  brand: "IronWrap",
  source_updated_at: "2026-07-16T10:00:00.000Z",
  read_model_generated_at: "2026-07-16T10:01:00.000Z",
  job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
  proposal: null,
  scope: [],
  progress: [],
  closeout: null,
  warranty: null,
};

describe("customer portal API", () => {
  it("uses one fixed path with omitted credentials and no-store caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(portal));

    const result = await loadCustomerPortal("a".repeat(43), fetcher);

    expect(result.job.job_number).toBe("IW-100");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/customer-portal/resolve",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ token: "a".repeat(43) }),
      }),
    );
  });
});
