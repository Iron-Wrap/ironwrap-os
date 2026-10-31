import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearDeviceSecret, storeDeviceSecret } from "../auth/device-credential";
import { SessionProvider } from "../auth/session-context";
import { getSessionReadObservation } from "../auth/principal-context";
import type { AuthenticatedSession } from "../auth/session";
import { apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { resetDatabaseForTests } from "../storage/db";
import type { TodayResponse } from "./field-contracts";
import { SavedPlanPage } from "./saved-plan-page";
import { TodayPage } from "./today-page";
import { savedPlanJobFixture, verifiedSavedPlanSessionFixture } from "./saved-plan-test-fixture";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ jobId: "JOB-SYNTHETIC" }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

function surface(client: QueryClient, session: AuthenticatedSession, today = false) {
  return (
    <QueryClientProvider client={client}>
      <SessionProvider session={session} readObservation={getSessionReadObservation(session)}>
        {today ? <TodayPage /> : <SavedPlanPage />}
      </SessionProvider>
    </QueryClientProvider>
  );
}

describe("mounted saved-plan and Today context withdrawal", () => {
  beforeEach(async () => {
    await storeDeviceSecret("a".repeat(43));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(savedPlanJobFixture())),
    );
  });
  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("withdraws the old worker's successful result immediately on same-user session replacement", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = await verifiedSavedPlanSessionFixture();
    const view = render(surface(client, first));
    await screen.findByRole("heading", { name: "Synthetic released work instructions" });
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));
    const replacement = await verifiedSavedPlanSessionFixture({
      user: { ...first.user, frappe_user_id: "replacement@example.invalid" },
    });
    view.rerender(surface(client, replacement));
    expect(
      screen.queryByRole("heading", { name: "Synthetic released work instructions" }),
    ).toBeNull();
    await screen.findByRole("heading", { name: "Plan unavailable" });
    const keys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    );
    expect(keys).not.toContain("a".repeat(43));
    expect(keys).not.toContain(first.csrf_token);
  });

  it("withdraws a mounted plan when its paired credential is cleared", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(surface(client, await verifiedSavedPlanSessionFixture()));
    await screen.findByRole("heading", { name: "Synthetic released work instructions" });
    await act(async () => {
      await clearDeviceSecret();
    });
    expect(
      screen.queryByRole("heading", { name: "Synthetic released work instructions" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
  });

  it("withdraws before a real magic-link API transition changes the cookie, and requires the fresh session", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = await verifiedSavedPlanSessionFixture();
    const view = render(surface(client, first));
    await screen.findByRole("heading", { name: "Synthetic released work instructions" });
    let finish: (response: Response) => void = () => {};
    const consume = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending: Promise<void>;
    act(() => {
      pending = apiCommand({
        path: API_PATHS.magicLinkConsume,
        body: { token: "synthetic-token" },
        fetcher: consume,
      });
    });
    await waitFor(() => expect(consume).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "Synthetic released work instructions" }),
    ).toBeNull();
    await act(async () => {
      finish(Response.json({}));
      await pending!;
    });
    expect(screen.getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    const replacement = await verifiedSavedPlanSessionFixture({
      user: { ...first.user, frappe_user_id: "replacement@example.invalid" },
    });
    const nextPlan = savedPlanJobFixture();
    nextPlan.packet.work_package!.title = "Current replacement-worker plan";
    vi.mocked(fetch).mockImplementation(async () => Response.json(nextPlan));
    view.rerender(surface(client, replacement));
    await screen.findByRole("heading", { name: "Current replacement-worker plan" });
  });

  it("withdraws a mounted plan at expiry without waiting for a failed session refetch", async () => {
    const now = Date.now();
    let clock = now;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const session = await verifiedSavedPlanSessionFixture({
      session_expires_at: new Date(now + 300).toISOString(),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(surface(client, session));
    await screen.findByRole("heading", { name: "Synthetic released work instructions" });
    clock = now + 301;
    await screen.findByRole("heading", { name: "Plan unavailable" });
    expect(
      screen.queryByRole("heading", { name: "Synthetic released work instructions" }),
    ).toBeNull();
  });

  it("does not publish an old-context Today prefetch or saved availability after worker replacement", async () => {
    const plan = savedPlanJobFixture();
    const today: TodayResponse = {
      version: 1,
      source_updated_at: plan.source_updated_at,
      read_model_generated_at: plan.read_model_generated_at,
      stale_fields: [],
      permissions: plan.permissions,
      allowed_actions: plan.allowed_actions,
      date: plan.read_model_generated_at.slice(0, 10),
      jobs: [
        {
          ...plan.job,
          scheduled_start: null,
          scheduled_end: null,
          blocked_gate_count: 1,
          next_action: "Check work",
          assignment: plan.assignment,
          active_stops: [],
        },
      ],
      work_objects: [],
    };
    const finish: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(async (path) =>
      String(path) === "/api/v1/today"
        ? Response.json(today)
        : await new Promise<Response>((resolve) => {
            finish.push(resolve);
          }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = await verifiedSavedPlanSessionFixture();
    const view = render(surface(client, first, true));
    await waitFor(() => expect(finish).toHaveLength(1));
    const replacement = await verifiedSavedPlanSessionFixture({
      user: { ...first.user, frappe_user_id: "replacement@example.invalid" },
    });
    view.rerender(surface(client, replacement, true));
    await waitFor(() => expect(finish).toHaveLength(2));
    await act(async () => {
      finish[0]!(Response.json(plan));
    });
    expect(screen.queryByRole("heading", { name: "Ready offline" })).toBeNull();
    await act(async () => {
      finish[1]!(Response.json(plan));
    });
    await screen.findByRole("heading", { name: "Ready offline" });
  });
});
