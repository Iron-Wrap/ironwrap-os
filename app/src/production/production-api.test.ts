import { describe, expect, it, vi } from "vitest";

import { API_PATHS } from "../lib/api-paths";
import { loadProductionRunway } from "./production-api";

function payload() {
  return {
    version: 1,
    source_updated_at: "2026-07-16T12:00:00.000Z",
    read_model_generated_at: "2026-07-16T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read"],
    partial_sources: [],
    summary: {
      active_jobs: 0,
      blocked: 0,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [],
  };
}

describe("Production runway API client", () => {
  it("uses the shared same-origin client for the read-only production endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));

    await loadProductionRunway(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      API_PATHS.production,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("rejects an incomplete response instead of rendering an inferred runway", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...payload(), summary: { active_jobs: 1 } }));

    await expect(loadProductionRunway(fetcher)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
