import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  apiCommand: vi.fn(),
}));
vi.mock("./session", async (original) => ({
  ...(await original<typeof import("./session")>()),
  fetchSession: vi.fn(),
}));

import { ApiError, apiCommand } from "../lib/api";
import { fetchSession } from "./session";
import { MagicLinkConsume } from "./magic-link-consume";
import { savedPlanSessionFixture } from "../field/saved-plan-test-fixture";

function show(token: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MagicLinkConsume token={token} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("magic consume preventive policy v1 caller", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("does not navigate or run a fallback auth read when durable preparation refused before HTTP", async () => {
    vi.mocked(apiCommand).mockRejectedValue(
      new ApiError({
        status: 0,
        code: "principal_prepare_failed",
        message: "Not dispatched",
        details: { dispatched: false },
      }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-policy-not-sent");
    await screen.findByRole("heading", { name: "Sign-in was not sent" });
    expect(apiCommand).toHaveBeenCalledOnce();
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not confirm a completed consume from an ordinary offline DTO", async () => {
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    vi.mocked(fetchSession).mockResolvedValue({
      ...savedPlanSessionFixture(),
      csrf_token: "offline-session-no-csrf",
    });
    show("synthetic-policy-unconfirmed");
    await screen.findByRole("heading", { name: "Sign-in needs checking" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not turn a lost consume answer into success through an unrelated fresh session DTO", async () => {
    vi.mocked(apiCommand).mockRejectedValue(
      new ApiError({ status: 0, code: "network_error", message: "Unknown outcome" }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-policy-lost-consume");
    await screen.findByRole("heading", { name: "Sign-in needs checking" });
    expect(fetchSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shares the actual consume and live follow-up through StrictMode without entering before consumption settles", async () => {
    let complete: (() => void) | undefined;
    vi.mocked(apiCommand).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-policy-success");
    expect(apiCommand).toHaveBeenCalledOnce();
    expect(fetchSession).not.toHaveBeenCalled();
    await act(async () => {
      complete!();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/today", replace: true }));
    expect(fetchSession).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the ordinary already-used-link recovery when a genuine live session succeeds", async () => {
    vi.mocked(apiCommand).mockRejectedValue(
      new ApiError({ status: 400, code: "invalid_token", message: "Used" }),
    );
    vi.mocked(fetchSession).mockResolvedValue(savedPlanSessionFixture());
    show("synthetic-policy-used-link");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/today", replace: true }));
    expect(apiCommand).toHaveBeenCalledOnce();
    expect(fetchSession).toHaveBeenCalledOnce();
  });
});
