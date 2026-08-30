import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { clearProductionGate } from "./production-gate-clearance-api";
import { GateClearancePanel } from "./production-gate-clearance-panel";
import type { ProductionRunwayJob } from "./production-contracts";

vi.mock("./production-gate-clearance-api", async () => {
  const actual = await vi.importActual<typeof import("./production-gate-clearance-api")>(
    "./production-gate-clearance-api",
  );
  return { ...actual, clearProductionGate: vi.fn() };
});

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read", "production_gate.clear"],
  csrf_token: "csrf",
  session_expires_at: "2026-08-21T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-21T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"] as const;

function job(blocked: readonly string[] = ["Deposit", "Weather"]): ProductionRunwayJob {
  return {
    id: "job:elec122",
    job_number: "IW-122",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "Won",
    version: 1,
    assignment: null,
    scheduling_preparation_allowed: false,
    lane: "blocked",
    next_action: "Resolve the source-backed blocker before dispatch review",
    gate_coverage: "complete",
    gate_summary: {
      expected: 6,
      blocked: blocked.length,
      ready: 6 - blocked.length,
      waived: 0,
      done: 0,
    },
    scheduling_gates: gateNames.map((name) => ({
      name,
      state: blocked.includes(name) ? "Blocked" : "Ready",
    })),
    material_attention: [],
  };
}

function renderPanel(target = job(), overrides: Partial<AuthenticatedSession> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={{ ...session, ...overrides }}>
        <GateClearancePanel job={target} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("GateClearancePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clearProductionGate).mockResolvedValue({
      gate: { state: "Waived" },
      basis: "office_waiver",
      clearance: "waived",
      evidence_item: null,
      actor_role: "IronWrap Owner",
      replayed: false,
    });
  });

  it("offers a clearing action for every blocking lock and nothing else", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText("2 locks still block this schedule")).toBeVisible();
    await user.click(screen.getByText("2 locks still block this schedule"));
    expect(screen.getByRole("button", { name: "Clear Deposit" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear Weather" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear Safety" })).not.toBeInTheDocument();
  });

  it("draws nothing at all once every lock is cleared", () => {
    const { container } = renderPanel(job([]));

    expect(container).toBeEmptyDOMElement();
  });

  it("records a waiver only once a real reason has been written", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText("2 locks still block this schedule"));
    await user.click(screen.getByRole("button", { name: "Clear Weather" }));
    const waive = screen.getByRole("button", { name: "Waive Weather on my authority" });
    expect(waive).toBeDisabled();

    await user.type(
      screen.getByLabelText("Why is Weather being waived?"),
      "Dry three-day window confirmed for Monday.",
    );
    expect(waive).toBeEnabled();
    await user.click(waive);

    await waitFor(() => expect(clearProductionGate).toHaveBeenCalledOnce());
    const input = vi.mocked(clearProductionGate).mock.calls[0]?.[1];
    expect(input).toEqual({
      roofJobId: "job:elec122",
      gate: "Weather",
      basis: "office_waiver",
      reason: "Dry three-day window confirmed for Monday.",
    });
  });

  it("says outright that a waiver is a decision and not a proof", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText("2 locks still block this schedule"));
    await user.click(screen.getByRole("button", { name: "Clear Weather" }));

    expect(screen.getByText(/A waiver is a decision, not a proof\./)).toBeVisible();
  });

  it("offers the settled-deposit clearance on Deposit and on no other lock", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText("2 locks still block this schedule"));
    await user.click(screen.getByRole("button", { name: "Clear Weather" }));
    expect(
      screen.queryByRole("button", { name: "Clear on the settled deposit" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear Deposit" }));
    await user.click(screen.getByRole("button", { name: "Clear on the settled deposit" }));

    const input = vi.mocked(clearProductionGate).mock.calls[0]?.[1];
    expect(input).toEqual({
      roofJobId: "job:elec122",
      gate: "Deposit",
      basis: "deposit_settlement",
    });
  });

  it("explains an unobserved settlement instead of asserting one", async () => {
    const user = userEvent.setup();
    vi.mocked(clearProductionGate).mockRejectedValue(
      new ApiError({
        message: "conflict",
        status: 409,
        code: "deposit_settlement_not_observed",
      }),
    );
    renderPanel();

    await user.click(screen.getByText("2 locks still block this schedule"));
    await user.click(screen.getByRole("button", { name: "Clear Deposit" }));
    await user.click(screen.getByRole("button", { name: "Clear on the settled deposit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /No settled deposit invoice is recorded for this job yet/,
    );
  });

  it("refuses to send a clearance from an offline session", async () => {
    const user = userEvent.setup();
    renderPanel(job(), { csrf_token: "offline-session-no-csrf" });

    await user.click(screen.getByText("2 locks still block this schedule"));
    await user.click(screen.getByRole("button", { name: "Clear Weather" }));
    await user.type(
      screen.getByLabelText("Why is Weather being waived?"),
      "Dry three-day window confirmed for Monday.",
    );

    expect(screen.getByRole("button", { name: "Waive Weather on my authority" })).toBeDisabled();
    expect(
      screen.getByText("This session is offline; a clearance is only recorded online."),
    ).toBeVisible();
    expect(clearProductionGate).not.toHaveBeenCalled();
  });
});
