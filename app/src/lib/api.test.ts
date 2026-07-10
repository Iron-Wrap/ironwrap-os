import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apiRequest, isRetryableApiError, retryAfterMilliseconds } from "./api";

describe("apiRequest", () => {
  it("sends same-origin credentials and parses the response contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ value: "ready" }, { headers: { "X-Request-ID": "req-1" } }),
      );

    const result = await apiRequest({
      path: "/api/v1/readiness",
      schema: z.object({ value: z.literal("ready") }),
      fetcher,
    });

    expect(result).toEqual({ value: "ready" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/readiness",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
  });

  it("fails closed when a successful response breaks its schema", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: true }));
    const request = apiRequest({
      path: "/api/v1/readiness",
      schema: z.object({ value: z.string() }),
      fetcher,
    });

    await expect(request).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  it("preserves server error codes, request ids, and retry timing", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "busy", message: "Try after the crew upload finishes.", request_id: "req-busy" },
          { status: 503, headers: { "Retry-After": "4" } },
        ),
      );
    let caught: unknown;
    try {
      await apiRequest({ path: "/api/v1/readiness", schema: z.unknown(), fetcher });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 503,
      code: "busy",
      requestId: "req-busy",
      retryAfterMs: 4_000,
    });
    expect(isRetryableApiError(caught)).toBe(true);
  });

  it("rejects paths that could bypass the versioned BFF", async () => {
    await expect(
      apiRequest({
        path: "https://example.com/api/v1/session",
        schema: z.unknown(),
        fetcher: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow("same-origin /api/v1/");
  });
});

describe("retryAfterMilliseconds", () => {
  it("accepts seconds and HTTP dates", () => {
    expect(retryAfterMilliseconds("3", 1_000)).toBe(3_000);
    expect(retryAfterMilliseconds(new Date(6_000).toUTCString(), 1_000)).toBe(5_000);
    expect(retryAfterMilliseconds("not-a-date", 1_000)).toBeUndefined();
  });
});
