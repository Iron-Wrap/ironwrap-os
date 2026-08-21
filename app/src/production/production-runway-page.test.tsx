import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadProductionRunway } from "./production-api";
import type { ProductionRunwayResponse } from "./production-contracts";
import { ProductionRunwayPage } from "./production-runway-page";

vi.mock("./production-api", () => ({ loadProductionRunway: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
  }) => (
    <a href={to.replace("$jobId", params?.jobId ?? "$jobId")} {...props}>
      {children}
    </a>
  ),
}));

const ownerSession = {
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
  allowed_actions: ["job.read", "production.read", "production_schedule_approval.prepare"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-16T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-16T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const productionSession = {
  ...ownerSession,
  user: {
    ...ownerSession.user,
    id: "appu_production",
    email: "production@example.invalid",
    display_name: "Production",
    role: "production",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read"],
} satisfies AuthenticatedSession;

const salesSession = {
  ...ownerSession,
  user: { ...ownerSession.user, role: "sales" },
} satisfies AuthenticatedSession;

const schedulingGateNames = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

function job(
  id: string,
  number: string,
  lane: ProductionRunwayResponse["jobs"][number]["lane"],
): ProductionRunwayResponse["jobs"][number] {
  return {
    id,
    job_number: number,
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "In Production",
    version: 1,
    assignment:
      lane === "needs_assignment"
        ? null
        : {
            id: `assignment:${id}`,
            type: "Production",
            status: lane === "blocked" ? "Blocked" : "Assigned",
            assignment_version: 1,
            roof_job_version: 1,
            crew_id: "crew:install",
            crew_version: 1,
            scheduled_start: lane === "scheduled" ? "2026-07-17T15:00:00.000Z" : null,
            scheduled_end: null,
          },
    lane,
    scheduling_preparation_allowed: id === "JOB-D",
    next_action:
      lane === "ready_for_review"
        ? "Review for scheduling; this view does not dispatch work"
        : "Review the source-backed operational condition",
    gate_coverage: lane === "needs_verification" ? "incomplete" : "complete",
    gate_summary: {
      expected: 6,
      blocked: lane === "blocked" ? 1 : 0,
      ready: lane === "blocked" ? 0 : 6,
      waived: 0,
      done: 0,
    },
    scheduling_gates: schedulingGateNames.map((name) => ({
      name,
      state: lane === "blocked" && name === "Materials" ? "Blocked" : "Ready",
    })),
    material_attention:
      lane === "blocked" ? [{ status: "Shortage", requested_delivery_date: null }] : [],
  };
}

function model(overrides: Partial<ProductionRunwayResponse> = {}): ProductionRunwayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-16T12:00:00.000Z",
    read_model_generated_at: "2026-07-16T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read", "production_schedule_approval.prepare"],
    partial_sources: [],
    summary: {
      active_jobs: 5,
      blocked: 1,
      scheduled: 1,
      needs_assignment: 1,
      ready_for_review: 1,
      needs_verification: 1,
    },
    jobs: [
      job("JOB-A", "IW-1001", "blocked"),
      job("JOB-B", "IW-1002", "scheduled"),
      job("JOB-C", "IW-1003", "needs_assignment"),
      job("JOB-D", "IW-1004", "ready_for_review"),
      job("JOB-E", "IW-1005", "needs_verification"),
    ],
    crews: [{ id: "crew:install", name: "Install team", version: 1 }],
    ...overrides,
  };
}

function renderRunway(session: AuthenticatedSession = ownerSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <ProductionRunwayPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("ProductionRunwayPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadProductionRunway).mockResolvedValue(model());
  });

  it("admits the dedicated production role and rejects other least-privilege roles", async () => {
    const productionView = renderRunway(productionSession);

    expect(await screen.findByRole("heading", { name: "Production plan" })).toBeVisible();
    expect(loadProductionRunway).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Open IW-1001" })).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(
      screen.queryByRole("link", { name: "Start schedule check for IW-1004" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Schedule requests" })).not.toBeInTheDocument();

    productionView.unmount();
    vi.clearAllMocks();
    renderRunway(salesSession);

    expect(
      screen.getByRole("heading", { name: "This work belongs to another role" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to Now" })).toHaveAttribute("href", "/now");
    expect(loadProductionRunway).not.toHaveBeenCalled();
  });

  it("keeps the runway read-only and links only eligible jobs to a schedule request", async () => {
    renderRunway();

    await screen.findByRole("heading", { name: "Production plan" });
    expect(screen.getByText(/This page does not change a job/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Schedule requests" })).toHaveAttribute(
      "href",
      "/production/schedule-approvals",
    );
    expect(screen.getByRole("heading", { name: "Work stopped" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ready to check" })).toBeVisible();
    expect(screen.getByText("Material issue")).toBeVisible();
    expect(screen.getByText("Shortage · Asked for: date not found")).toBeVisible();
    expect(screen.getAllByText("Start steps").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Deposit: Ready").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Completion:/)).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/Final work is checked when the job is done/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open IW-1001" })).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(screen.getByRole("link", { name: "Start schedule check for IW-1004" })).toHaveAttribute(
      "href",
      "/production/schedule/JOB-D",
    );
    expect(
      screen.queryByRole("link", { name: "Start schedule check for IW-1001" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule|dispatch/i })).not.toBeInTheDocument();
    expect(screen.getByText("JOB-A")).not.toBeVisible();
    await userEvent.setup().click(screen.getAllByText("System details")[0]!);
    expect(screen.getByText("JOB-A")).toBeVisible();
  });

  it("makes incomplete source coverage explicit", async () => {
    vi.mocked(loadProductionRunway).mockResolvedValue(
      model({
        partial_sources: ["gate_states"],
        stale_fields: ["jobs.partial_sources", "jobs.gate_coverage"],
      }),
    );
    renderRunway();

    await screen.findByRole("heading", { name: "Production plan" });
    expect(screen.getByRole("heading", { name: "Some job data is missing" })).toBeVisible();
    expect(screen.getByText(/Missing from: gate states/i)).toBeVisible();
    expect(screen.getByText(/Do not send a crew until you check the job/i)).toBeVisible();
  });

  it("only offers to clear a lock when the read model says this session may", async () => {
    const readOnly = renderRunway();

    await screen.findByRole("heading", { name: "Production plan" });
    // The default model does not grant `production_gate.clear`, so a blocked job
    // shows its locks and no way to touch them.
    expect(screen.getByLabelText("Materials: Blocked")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear Materials" })).not.toBeInTheDocument();

    readOnly.unmount();
    vi.mocked(loadProductionRunway).mockResolvedValue(
      model({
        allowed_actions: [
          "job.read",
          "production.read",
          "production_gate.clear",
          "production_schedule_approval.prepare",
        ],
      }),
    );
    renderRunway();

    expect(await screen.findByRole("button", { name: "Clear Materials" })).toBeVisible();
  });

  it("keeps a returned requested-delivery date visible without shifting the calendar day", async () => {
    vi.mocked(loadProductionRunway).mockResolvedValue(
      model({
        jobs: [
          {
            ...job("JOB-A", "IW-1001", "blocked"),
            material_attention: [{ status: "Shortage", requested_delivery_date: "2026-07-22" }],
          },
        ],
      }),
    );
    renderRunway();

    await screen.findByRole("heading", { name: "Production plan" });
    expect(screen.getByText("Shortage · Asked for: Jul 22, 2026")).toBeVisible();
  });
});
