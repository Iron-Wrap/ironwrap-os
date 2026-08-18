import { describe, expect, it } from "vitest";

import { pairingExpiryLabel, safeHermesDesktopPairingUrl, safePairingUrl } from "./pairing-link";

const token = "a".repeat(43);

describe("safePairingUrl", () => {
  it("accepts only a same-origin fragment-only pairing URL", () => {
    expect(
      safePairingUrl(
        `https://app.example.test/auth/pair#token=${token}`,
        "https://app.example.test",
      ),
    ).toBe(`https://app.example.test/auth/pair#token=${token}`);
  });

  it("accepts the separate same-origin Hermes desktop fragment path", () => {
    expect(
      safeHermesDesktopPairingUrl(
        `https://app.example.test/auth/hermes-pair#token=${token}`,
        "https://app.example.test",
      ),
    ).toBe(`https://app.example.test/auth/hermes-pair#token=${token}`);
    expect(
      safeHermesDesktopPairingUrl(
        `https://app.example.test/auth/pair#token=${token}`,
        "https://app.example.test",
      ),
    ).toBeUndefined();
  });

  it("rejects cross-origin, query-string, and malformed pairing links", () => {
    const origin = "https://app.example.test";
    expect(safePairingUrl(`https://evil.example/auth/pair#token=${token}`, origin)).toBeUndefined();
    expect(safePairingUrl(`${origin}/auth/pair?token=${token}`, origin)).toBeUndefined();
    expect(safePairingUrl(`${origin}/auth/pair#token=too-short`, origin)).toBeUndefined();
    expect(
      safePairingUrl(`${origin}/auth/pair#token=${token}&token=${token}`, origin),
    ).toBeUndefined();
  });
});

describe("pairingExpiryLabel", () => {
  it("makes short expiry and expiry truth explicit", () => {
    expect(
      pairingExpiryLabel("2026-07-10T12:01:00.000Z", Date.parse("2026-07-10T12:00:31.000Z")),
    ).toBe("Expires in under one minute.");
    expect(
      pairingExpiryLabel("2026-07-10T12:00:00.000Z", Date.parse("2026-07-10T12:00:01.000Z")),
    ).toBe("Expired. Issue a new code.");
  });
});
