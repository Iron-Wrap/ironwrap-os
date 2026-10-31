import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { getDeviceSecret, storeDeviceSecret } from "../auth/device-credential";
import { ApiError, apiRequest, isRetryableApiError, retryAfterMilliseconds } from "./api";

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

  it("ends an answer whose headers arrive but whose body stalls, instead of waiting for ever", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 201 },
        ),
    );
    await expect(
      apiRequest({ path: "/api/v1/readiness", schema: z.object({}), fetcher, timeoutMs: 20 }),
    ).rejects.toMatchObject({ status: 201, code: "response_lost" });
  });

  it("calls a cut-off successful body unreadable, keeping its status", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"result":"sto', { status: 201 }));
    await expect(
      apiRequest({ path: "/api/v1/readiness", schema: z.object({}), fetcher }),
    ).rejects.toMatchObject({ status: 201, code: "invalid_json" });
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

  it("adds device proof only when a device-bound request supplies it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: "ready" }));

    await apiRequest({
      path: "/api/v1/readiness",
      schema: z.object({ value: z.literal("ready") }),
      deviceProof: async () => "device-proof-not-persisted",
      fetcher,
    });

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-IronWrap-Device-Proof")).toBe("device-proof-not-persisted");
  });

  it("sends a bounded idempotency key only when a governed decision supplies one", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: "recorded" }));

    await apiRequest({
      path: "/api/v1/approvals/approval%3Atest/approve",
      schema: z.object({ value: z.literal("recorded") }),
      method: "POST",
      body: { version: 1 },
      csrfToken: "csrf-token",
      idempotencyKey: "approval:test-key-0001",
      deviceActionId: "device-action-0001",
      fetcher,
    });

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("approval:test-key-0001");
    expect(headers.get("X-Device-Action-Id")).toBe("device-action-0001");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
  });

  it("clears a rejected device proof without storing it in request state", async () => {
    await storeDeviceSecret("d".repeat(43));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));

    await expect(
      apiRequest({
        path: "/api/v1/today",
        schema: z.unknown(),
        deviceProof: getDeviceSecret,
        fetcher,
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(await getDeviceSecret()).toBeUndefined();
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

  /**
   * A refused command carries the facts that make it actionable — `required_role` on a
   * stage refusal, `card_version` on a CAS conflict, `undo_window_seconds` on an expired
   * undo. Dropping them is what forces a surface to render "something went wrong".
   */
  it("keeps the rest of a refusal body so a surface can render the exact blocker", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "stage_entry_role_required", required_role: "production", card_version: 12 },
          { status: 403 },
        ),
      );
    let caught: unknown;
    try {
      await apiRequest({ path: "/api/v1/pipelines", schema: z.unknown(), fetcher });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.code).toBe("stage_entry_role_required");
    expect(error.detailText("required_role")).toBe("production");
    expect(error.detailNumber("card_version")).toBe(12);
    // The envelope fields stay on their own properties rather than doubling up in details.
    expect(error.details).not.toHaveProperty("error");
    expect(error.detailText("card_version")).toBeUndefined();
    expect(error.detailNumber("required_role")).toBeUndefined();
  });

  it("carries an empty detail bag when the server sent no extra facts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));
    let caught: unknown;
    try {
      await apiRequest({ path: "/api/v1/pipelines", schema: z.unknown(), fetcher });
    } catch (error) {
      caught = error;
    }

    expect((caught as ApiError).details).toEqual({});
    expect((caught as ApiError).detailText("required_role")).toBeUndefined();
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

describe("request bodies and headers", () => {
  it("keeps JSON as the default ask for every other call", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await apiRequest({
      path: "/api/v1/readiness",
      schema: z.object({ ok: z.boolean() }),
      fetcher,
    });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("Accept")).toBe("application/json");
  });

  it("sends a multipart body without setting its content type", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const form = new FormData();
    form.append("purpose", "stock");
    await apiRequest({
      path: "/api/v1/evidence-uploads",
      schema: z.object({ ok: z.boolean() }),
      method: "POST",
      body: form,
      fetcher,
    });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect((init?.headers as Headers).has("Content-Type")).toBe(false);
  });
});
