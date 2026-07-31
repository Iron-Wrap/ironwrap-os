import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingMagicLinkToken,
  extractAndScrubMagicLinkToken,
  takeMagicLinkTokenFromWindow,
} from "./magic-link-fragment";

afterEach(() => clearPendingMagicLinkToken());

describe("extractAndScrubMagicLinkToken", () => {
  it("takes the token from the fragment and scrubs it before consumption", () => {
    const replaceState = vi.fn();
    const token = extractAndScrubMagicLinkToken(
      { pathname: "/auth/verify", search: "", hash: "#token=secret-value" },
      { state: { navigation: 1 }, replaceState },
    );

    expect(token).toBe("secret-value");
    expect(replaceState).toHaveBeenCalledWith({ navigation: 1 }, "", "/auth/verify");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain("secret-value");
  });

  it("does not accept a token from the query string", () => {
    const replaceState = vi.fn();
    const token = extractAndScrubMagicLinkToken(
      { pathname: "/auth/verify", search: "?token=logged-value", hash: "" },
      { state: null, replaceState },
    );

    expect(token).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("keeps an early-scrubbed token available to its route, then permits a later link", () => {
    window.history.replaceState(null, "", "/portal#token=portal-token");

    expect(takeMagicLinkTokenFromWindow()).toBe("portal-token");
    expect(window.location.hash).toBe("");

    clearPendingMagicLinkToken();
    window.history.replaceState(null, "", "/contract-accept#token=acceptance-token");
    expect(takeMagicLinkTokenFromWindow()).toBe("acceptance-token");
  });
});
