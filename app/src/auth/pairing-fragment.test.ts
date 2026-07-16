import { describe, expect, it, vi } from "vitest";

import { extractAndScrubPairingToken } from "./pairing-fragment";

describe("extractAndScrubPairingToken", () => {
  it("takes a pairing token from the fragment and scrubs it before consumption", () => {
    const replaceState = vi.fn();
    const token = extractAndScrubPairingToken(
      { pathname: "/auth/pair", search: "", hash: "#token=secret-value" },
      { state: { navigation: 1 }, replaceState },
    );

    expect(token).toBe("secret-value");
    expect(replaceState).toHaveBeenCalledWith({ navigation: 1 }, "", "/auth/pair");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain("secret-value");
  });

  it("does not accept a pairing token from the query string", () => {
    const replaceState = vi.fn();
    const token = extractAndScrubPairingToken(
      { pathname: "/auth/pair", search: "?token=logged-value", hash: "" },
      { state: null, replaceState },
    );

    expect(token).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
