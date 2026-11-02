import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./device-pairing", () => ({ pairDevice: vi.fn() }));
vi.mock("./session", async (original) => ({
  ...(await original<typeof import("./session")>()),
  fetchSession: vi.fn(),
}));

import { ApiError } from "../lib/api";
import { pairDevice } from "./device-pairing";
import { fetchSession } from "./session";
import { DevicePairingConsume } from "./device-pairing-consume";
import { savedPlanSessionFixture } from "../field/saved-plan-test-fixture";

function show(token: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <DevicePairingConsume token={token} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("pair consume preventive policy v1 caller", () => {
  afterEach(() => vi.resetAllMocks());

  it("does not fall through to an older sign-in when preparation refused before HTTP", async () => {
    vi.mocked(pairDevice).mockRejectedValue(
      new ApiError({
        status: 0,
        code: "principal_prepare_failed",
        message: "Not dispatched",
        details: { dispatched: false },
      }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-pair-not-sent");
    await screen.findByRole("heading", { name: "Pairing was not sent" });
    expect(pairDevice).toHaveBeenCalledOnce();
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("cannot confirm proof-storage failure using an ordinary offline DTO", async () => {
    vi.mocked(pairDevice).mockRejectedValue(
      new DOMException("Synthetic post-consume storage failure", "QuotaExceededError"),
    );
    vi.mocked(fetchSession).mockResolvedValue({
      ...savedPlanSessionFixture(),
      csrf_token: "offline-session-no-csrf",
    });
    show("synthetic-pair-unconfirmed");
    await screen.findByRole("heading", { name: "Pairing needs checking" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not turn a lost pairing answer into success through an unrelated fresh field DTO", async () => {
    vi.mocked(pairDevice).mockRejectedValue(
      new ApiError({ status: 0, code: "network_error", message: "Unknown outcome" }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-pair-lost-consume");
    await screen.findByRole("heading", { name: "Pairing needs checking" });
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps StrictMode inside the real consume-to-proof-store operation before navigation", async () => {
    let complete: (() => void) | undefined;
    vi.mocked(pairDevice).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-pair-success");
    expect(pairDevice).toHaveBeenCalledOnce();
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      complete!();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/today", replace: true }));
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("preserves already-paired recovery through a genuine live field session", async () => {
    vi.mocked(pairDevice).mockRejectedValue(
      new ApiError({ status: 400, code: "invalid_token", message: "Used" }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-pair-used");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/today", replace: true }));
    expect(pairDevice).toHaveBeenCalledOnce();
    expect(fetchSession).toHaveBeenCalledOnce();
  });
});
