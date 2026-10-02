import { afterEach, describe, expect, it, vi } from "vitest";

const constructedShapes = vi.hoisted(() => [] as string[][]);

vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  return {
    ...actual,
    z: {
      ...actual.z,
      object: new Proxy(actual.z.object, {
        apply(target, receiver, args) {
          constructedShapes.push(Object.keys(args[0]));
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
  };
});

import { loadPublicEstimateConfig } from "./public-estimate-config";
import { PublicEstimateApiError } from "./public-estimate-request";

// A branding read must not initialize the unrelated form/submission module on every app boot.
vi.mock("./public-estimate-contracts", () => {
  throw new Error("The branding read loaded the public estimate form contracts");
});

const config = {
  enabled: true,
  turnstile_site_key: null,
  range_available: false,
  disclaimer: "An estimator must review the request.",
  review_required: true,
  brands: [{ id: "freshco", display_name: "FreshCo", short_name: "FC", service_area: "Alberta" }],
  default_brand: "freshco",
  logo_url: "/public/company-logo?v=1",
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("public branding configuration read", () => {
  it("builds the config validator on its first read, not while every shell boots", async () => {
    vi.resetModules();
    constructedShapes.length = 0;
    const fresh = await import("./public-estimate-config");
    const configBuilds = () => constructedShapes.filter((shape) => shape.includes("logo_url"));
    expect(configBuilds()).toHaveLength(0);

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(config));
    await expect(fresh.loadPublicEstimateConfig(fetcher)).resolves.toEqual(config);
    await expect(fresh.loadPublicEstimateConfig(fetcher)).resolves.toEqual(config);
    expect(configBuilds()).toHaveLength(1);
  });

  it("validates the complete config through the same credential-free uncached endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(config));
    await expect(loadPublicEstimateConfig(fetcher)).resolves.toEqual(config);
    expect(fetcher).toHaveBeenCalledOnce();
    const [path, request] = fetcher.mock.calls[0]!;
    expect(path).toBe("/public/instant-estimate/config");
    expect(request).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "strict-origin",
    });
    const headers = new Headers(request?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect([...headers]).toHaveLength(1);
    expect(request?.body).toBeUndefined();
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { range_available: true },
    { review_required: false },
    { logo_url: "" },
    { brands: [{ ...config.brands[0], id: "" }] },
    { default_brand: 123 },
  ])("rejects malformed or authority-changing config: %j", async (changes) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...config, ...changes }));
    await expect(loadPublicEstimateConfig(fetcher)).rejects.toMatchObject({
      name: "PublicEstimateApiError",
      code: "invalid_response",
    });
  });

  it("preserves disabled and unfinished setup responses without inventing a brand or logo", async () => {
    const setup = { ...config, enabled: false, brands: [], default_brand: null, logo_url: null };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(setup));
    await expect(loadPublicEstimateConfig(fetcher)).resolves.toEqual(setup);
  });

  it("preserves the typed server error and public message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "rate_limited" }, 429));
    const error = await loadPublicEstimateConfig(fetcher).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PublicEstimateApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      message: "Too many requests were sent. Please wait a moment and try again.",
    });
  });

  it("preserves invalid-JSON and network failures", async () => {
    await expect(
      loadPublicEstimateConfig(vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON"))),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      loadPublicEstimateConfig(vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"))),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("still aborts a stalled read at twelve seconds and clears the timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_path, request) => {
      signal = request?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    const outcome = expect(loadPublicEstimateConfig(fetcher)).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
