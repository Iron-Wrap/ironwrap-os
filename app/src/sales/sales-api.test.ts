import { describe, expect, it, vi } from "vitest";

import { loadSales } from "./sales-api";

describe("sales API", () => {
  it("loads the allowlisted Sales Desk through the same-origin BFF", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        source_updated_at: null,
        read_model_generated_at: "2026-07-11T12:00:00.000Z",
        stale_fields: [],
        permissions: ["sales:read"],
        allowed_actions: ["sales.read"],
        partial_sources: [],
        summary: {
          listed_leads: 0,
          triage_unresolved: 0,
          estimate_needs_review: 0,
          quote_needs_review: 0,
          quote_expired: 0,
          no_linked_consent_record: 0,
        },
        leads: [],
      }),
    );

    const response = await loadSales(fetcher);

    expect(response.summary.listed_leads).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/sales",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
  });
});
