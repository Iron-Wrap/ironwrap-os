import { describe, expect, it, vi } from "vitest";

import { loadNewoOperations } from "./newo-operations-api";
import { newoOperationsFixture } from "./newo-operations-test-fixture";

describe("loadNewoOperations", () => {
  it("uses the authenticated same-origin read route with no browser caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(newoOperationsFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await loadNewoOperations(fetcher);

    expect(result.counts.missing_reports).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/newo/operations");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("fails closed when the server widens a session with caller data", async () => {
    const widened = newoOperationsFixture();
    widened.recent_sessions[0] = {
      ...widened.recent_sessions[0],
      contact_email: "private@example.com",
    } as never;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(widened), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(loadNewoOperations(fetcher)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
