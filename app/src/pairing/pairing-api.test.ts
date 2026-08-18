import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { consumeDevicePairing, issueDevicePairing, issueHermesDesktopPairing } from "./pairing-api";

const officeSession: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.test",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: [],
  csrf_token: "office-csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
};

const pairedSession = {
  ...officeSession,
  user: { ...officeSession.user, id: "appu_field", role: "field" as const },
  csrf_token: "field-csrf",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("device pairing API client", () => {
  it("issues a pairing against the exact office endpoint with CSRF", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        pairing_url: "https://app.example.test/auth/pair#token=" + "t".repeat(43),
        expires_at: "2026-07-10T12:10:00.000Z",
        field_user: { id: "appu_field", display_name: "Crew" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    await issueDevicePairing(officeSession, "appu_field");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/device-pairings",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ field_user_id: "appu_field" });
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("office-csrf");
  });

  it("consumes a fragment token and proof in a POST body, then validates the field session", async () => {
    const token = "t".repeat(43);
    const deviceProof = "d".repeat(43);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pairedSession));
    vi.stubGlobal("fetch", fetcher);

    const result = await consumeDevicePairing(token, deviceProof);

    expect(result).toMatchObject({ authenticated: true, user: { role: "field" } });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/device-pairing/consume",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ token, device_proof: deviceProof });
    expect(new Headers(init?.headers).get("X-IronWrap-Device-Proof")).toBeNull();
  });

  it("accepts only a complete server-bound Hermes bootstrap contract", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        pairing_url: "https://app.example.test/auth/hermes-pair#token=" + "t".repeat(43),
        expires_at: "2026-07-10T12:10:00.000Z",
        api_audience: "https://app.example.test",
        bound_issuer: "https://app.example.test",
        bootstrap_prompt: "Use the exact bound audience and one-time link.",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await issueHermesDesktopPairing(officeSession);

    expect(result.api_audience).toBe("https://app.example.test");
    expect(result.bootstrap_prompt).toContain("bound audience");
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("office-csrf");
  });

  it("rejects a schema-valid response that does not create a field session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(officeSession));
    vi.stubGlobal("fetch", fetcher);

    await expect(consumeDevicePairing("t".repeat(43), "d".repeat(43))).rejects.toMatchObject({
      code: "invalid_pairing_session",
    });
  });
});
